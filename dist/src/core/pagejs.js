/**
 * In-page JavaScript snippets shared by BOTH page-control drivers (BiDi for
 * Firefox, CDP for Chrome/Edge). Every snippet is a single EXPRESSION that
 * evaluates to a JSON string, so both protocols get back `{type:"string"}`
 * and the driver just JSON.parses it — identical semantics in every browser.
 *
 * All user-supplied fragments (selectors, values, expressions) are embedded
 * via JSON.stringify so quotes/backslashes/newlines can never break out of
 * the generated code.
 */
/** Embed a user string safely inside generated JS. */
function lit(value) {
    return JSON.stringify(value);
}
/** Guard: every expression we build must parse as valid JS. Catches
 *  generator bugs (unbalanced braces etc.) before they reach a browser. */
export function assertParses(expr) {
    // new Function only PARSES here — nothing is executed.
    new Function(`return (${expr});`);
    return expr;
}
/** Page metadata: url, title, readyState. */
export function metaExpr() {
    return assertParses(`JSON.stringify({ url: location.href, title: document.title, readyState: document.readyState })`);
}
/** Visible text of the page (or of the first element matching `selector`),
 *  trimmed and capped so a huge page can't flood the agent's context. */
export function textExpr(selector, maxChars) {
    const target = selector === undefined ? "document.body" : `document.querySelector(${lit(selector)})`;
    return assertParses(`JSON.stringify((() => {
      const el = ${target};
      if (!el) return { found: false, text: "" };
      const t = (el.innerText ?? el.textContent ?? "").trim();
      return { found: true, truncated: t.length > ${maxChars}, text: t.slice(0, ${maxChars}) };
    })())`);
}
/** Click the first element matching `selector` (scrolls it into view first). */
export function clickExpr(selector) {
    return assertParses(`JSON.stringify((() => {
      const el = document.querySelector(${lit(selector)});
      if (!el) return { clicked: false, error: "no element matches selector" };
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return { clicked: true };
    })())`);
}
/**
 * Fill a form control and fire the events frameworks listen for. Handles
 * <input>/<textarea>/<select> plus contenteditable. React needs the native
 * value setter so its synthetic-event layer sees the change.
 */
export function fillExpr(selector, value) {
    return assertParses(`JSON.stringify((() => {
      const el = document.querySelector(${lit(selector)});
      if (!el) return { filled: false, error: "no element matches selector" };
      el.focus();
      const v = ${lit(value)};
      if (el.isContentEditable) {
        el.textContent = v;
      } else if (el.tagName === "SELECT") {
        el.value = v;
      } else {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, v); else el.value = v;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, value: el.isContentEditable ? el.textContent : el.value };
    })())`);
}
/**
 * Wrap a caller-supplied EXPRESSION for page_eval. The result is awaited
 * (so `fetch(...).then(r=>r.json())` works) and JSON-stringified in-page;
 * values that can't be JSON-encoded fall back to String(value).
 */
export function evalWrapperExpr(userExpression) {
    // Parse-check the USER expression separately so a syntax error is reported
    // against their code, not our wrapper.
    new Function(`return (${userExpression});`);
    return assertParses(`(async () => {
      const __r = await (${userExpression});
      if (__r === undefined) return "null";
      try { return JSON.stringify(__r) ?? JSON.stringify(String(__r)); }
      catch { return JSON.stringify(String(__r)); }
    })()`);
}
