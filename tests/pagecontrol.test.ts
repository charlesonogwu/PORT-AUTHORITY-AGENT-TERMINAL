import { test } from "node:test";
import assert from "node:assert/strict";
import { Lane, nowIso } from "../src/core/lane.js";
import {
  assertParses,
  clickExpr,
  evalWrapperExpr,
  fillExpr,
  metaExpr,
  textExpr,
} from "../src/core/pagejs.js";
import { PageControlError, TEXT_CAP_CHARS, openPageController, pickTab } from "../src/core/pagecontrol.js";

function laneWith(overrides: Partial<Lane> = {}): Lane {
  return {
    id: "lane_pc",
    owner: "codex",
    project: "vend",
    cwd: "/tmp/vend",
    sessionId: "default",
    chromeDebugPort: 9370,
    chromeProfileDir: "C:/pp/profiles/codex-vend",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...overrides,
  };
}

// ── pagejs: every generated snippet must PARSE as valid JS ──────────────────
// This guards the exact bug class that bit the old bridge: an unbalanced
// brace in generated code reaching the browser as a SyntaxError.

test("all snippet builders emit parseable JS", () => {
  assert.doesNotThrow(() => metaExpr());
  assert.doesNotThrow(() => textExpr(undefined, TEXT_CAP_CHARS));
  assert.doesNotThrow(() => textExpr("#main", 100));
  assert.doesNotThrow(() => clickExpr("button.primary"));
  assert.doesNotThrow(() => fillExpr("#email", "a@b.com"));
});

test("assertParses throws on broken JS", () => {
  assert.throws(() => assertParses("(()=>{})()}"));
  assert.throws(() => assertParses("{ nope"));
});

// ── injection safety: hostile selectors/values can't break out ───────────────

const HOSTILE = `'"\`\\); document.title='pwned'; //\n$\{x\}`;

test("hostile selector stays a string literal in click/fill/text", () => {
  for (const expr of [clickExpr(HOSTILE), fillExpr(HOSTILE, HOSTILE), textExpr(HOSTILE, 50)]) {
    // Still parses (would throw if the payload escaped its string literal)…
    assert.doesNotThrow(() => new Function(`return (${expr});`));
    // …and the payload appears exactly as one JSON string literal (data, not code).
    assert.ok(expr.includes(JSON.stringify(HOSTILE)), "payload must be embedded via JSON.stringify");
  }
});

test("fill value with newlines and quotes survives JSON round-trip encoding", () => {
  const expr = fillExpr("#x", 'line1\nline2 "quoted" \\slash');
  assert.doesNotThrow(() => new Function(`return (${expr});`));
});

// ── evalWrapperExpr ──────────────────────────────────────────────────────────

test("evalWrapperExpr wraps a valid expression and rejects broken ones", () => {
  const wrapped = evalWrapperExpr("1 + 1");
  assert.doesNotThrow(() => new Function(`return (${wrapped});`));
  assert.match(wrapped, /await \(1 \+ 1\)/);
  assert.throws(() => evalWrapperExpr("this is not js"));
  assert.throws(() => evalWrapperExpr("(()=>{})()}"));
});

// ── pickTab: id, index, and substring addressing ─────────────────────────────

const TABS = [
  { id: "aaa-111", url: "https://example.com/", title: "Example Domain" },
  { id: "bbb-222", url: "https://www.ebay.com/itm/318423211496", title: "X98 Keyboard | eBay" },
];

test("pickTab: no ref → first tab; exact id wins", () => {
  assert.equal(pickTab(TABS, undefined).id, "aaa-111");
  assert.equal(pickTab(TABS, "bbb-222").id, "bbb-222");
});

test("pickTab: numeric ref is a 0-based index", () => {
  assert.equal(pickTab(TABS, "0").id, "aaa-111");
  assert.equal(pickTab(TABS, "1").id, "bbb-222");
  assert.throws(() => pickTab(TABS, "5"), PageControlError);
});

test("pickTab: url/title substring, case-insensitive", () => {
  assert.equal(pickTab(TABS, "itm").id, "bbb-222");
  assert.equal(pickTab(TABS, "keyboard").id, "bbb-222");
  assert.equal(pickTab(TABS, "EXAMPLE").id, "aaa-111");
  assert.throws(() => pickTab(TABS, "nothing-matches"), PageControlError);
});

test("pickTab: empty tab list is a clear error", () => {
  assert.throws(() => pickTab([], undefined), PageControlError);
});

// ── openPageController guard rails (no browser needed) ───────────────────────

test("openPageController refuses a lane with no debug port", async () => {
  await assert.rejects(
    () => openPageController(laneWith({ chromeDebugPort: undefined })),
    (err: Error) => err instanceof PageControlError && /no debug port/.test(err.message),
  );
});
