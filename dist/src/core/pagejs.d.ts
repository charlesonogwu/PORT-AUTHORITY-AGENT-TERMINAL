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
/** Guard: every expression we build must parse as valid JS. Catches
 *  generator bugs (unbalanced braces etc.) before they reach a browser. */
export declare function assertParses(expr: string): string;
/** Page metadata: url, title, readyState. */
export declare function metaExpr(): string;
/** Visible text of the page (or of the first element matching `selector`),
 *  trimmed and capped so a huge page can't flood the agent's context. */
export declare function textExpr(selector: string | undefined, maxChars: number): string;
/** Click the first element matching `selector` (scrolls it into view first). */
export declare function clickExpr(selector: string): string;
/**
 * Fill a form control and fire the events frameworks listen for. Handles
 * <input>/<textarea>/<select> plus contenteditable. React needs the native
 * value setter so its synthetic-event layer sees the change.
 */
export declare function fillExpr(selector: string, value: string): string;
/**
 * Wrap a caller-supplied EXPRESSION for page_eval. The result is awaited
 * (so `fetch(...).then(r=>r.json())` works) and JSON-stringified in-page;
 * values that can't be JSON-encoded fall back to String(value).
 */
export declare function evalWrapperExpr(userExpression: string): string;
