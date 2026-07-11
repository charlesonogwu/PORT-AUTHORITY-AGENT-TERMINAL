import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeOwner, KNOWN_LLM_OWNERS } from "../src/core/lane.js";
import { allocateLane } from "../src/core/allocator.js";
import { withTempHome } from "./helpers.js";
import { PortObservation } from "../src/core/scanner.js";

const empty: PortObservation[] = [];

test("canonicalizeOwner: bare LLM name passes through unchanged", () => {
  for (const name of KNOWN_LLM_OWNERS) {
    const r = canonicalizeOwner(name);
    assert.equal(r.canonical, name);
    assert.equal(r.custom, undefined);
  }
});

test("canonicalizeOwner: goose and opencode are recognized owners", () => {
  assert.deepEqual(canonicalizeOwner("goose"), { canonical: "goose" });
  assert.deepEqual(canonicalizeOwner("Goose-task1"), { canonical: "goose", custom: "task1" });
  assert.deepEqual(canonicalizeOwner("opencode"), { canonical: "opencode" });
  assert.deepEqual(canonicalizeOwner("OpenCode_web"), { canonical: "opencode", custom: "web" });
});

test("canonicalizeOwner: names only match at word boundaries (no false positives inside words)", () => {
  // "mongoose" contains "goose" but is NOT the goose agent.
  assert.deepEqual(canonicalizeOwner("mongoose"), { canonical: "agent", custom: "mongoose" });
  // "opencoder" contains "opencode" but with a trailing letter — not a match.
  assert.deepEqual(canonicalizeOwner("opencoder"), { canonical: "agent", custom: "opencoder" });
  // Boundary characters (separators) still match fine.
  assert.deepEqual(canonicalizeOwner("my-goose"), { canonical: "goose", custom: "my" });
});

test("canonicalizeOwner: extracts custom suffix when LLM name is embedded", () => {
  assert.deepEqual(canonicalizeOwner("codex-test-alpha"), { canonical: "codex", custom: "test-alpha" });
  assert.deepEqual(canonicalizeOwner("claude-vend-site"),  { canonical: "claude", custom: "vend-site" });
  assert.deepEqual(canonicalizeOwner("ClAude_v2"),         { canonical: "claude", custom: "v2" });
  assert.deepEqual(canonicalizeOwner("anthropic-claude"),  { canonical: "claude", custom: "anthropic" });
});

test("canonicalizeOwner: unknown LLM falls back to 'agent' but preserves custom string", () => {
  assert.deepEqual(canonicalizeOwner("agent-random-1"),  { canonical: "agent", custom: "agent-random-1" });
  assert.deepEqual(canonicalizeOwner("batch2-agent-3"),  { canonical: "agent", custom: "batch2-agent-3" });
  assert.deepEqual(canonicalizeOwner("nameless"),        { canonical: "agent", custom: "nameless" });
});

test("canonicalizeOwner: literal 'agent' has no custom suffix", () => {
  assert.deepEqual(canonicalizeOwner("agent"), { canonical: "agent" });
  assert.deepEqual(canonicalizeOwner("AGENT"), { canonical: "agent" });
});

test("canonicalizeOwner: empty / whitespace falls back to 'agent' with no custom", () => {
  assert.deepEqual(canonicalizeOwner(""),     { canonical: "agent" });
  assert.deepEqual(canonicalizeOwner("   "),  { canonical: "agent" });
  assert.deepEqual(canonicalizeOwner(undefined as unknown as string), { canonical: "agent" });
});

test("canonicalizeOwner: handles underscore and space separators", () => {
  assert.deepEqual(canonicalizeOwner("codex_alpha_one"),  { canonical: "codex",  custom: "alpha-one" });
  assert.deepEqual(canonicalizeOwner("codex alpha one"),  { canonical: "codex",  custom: "alpha-one" });
});

test("allocateLane stores canonical owner, not the raw string", async () => {
  await withTempHome(async () => {
    const r = await allocateLane({
      owner: "codex-test-alpha",
      cwd: "/tmp/x",
      observations: empty,
    });
    assert.equal(r.lane.owner, "codex");
    // Custom suffix auto-promoted to sessionId since none was supplied.
    assert.equal(r.lane.sessionId, "test-alpha");
  });
});

test("allocateLane: explicit sessionId beats auto-promoted suffix", async () => {
  await withTempHome(async () => {
    const r = await allocateLane({
      owner: "codex-test-alpha",
      cwd: "/tmp/x",
      sessionId: "explicit",
      observations: empty,
    });
    assert.equal(r.lane.owner, "codex");
    assert.equal(r.lane.sessionId, "explicit");
  });
});

test("allocateLane: unknown LLM owner becomes 'agent', original promoted to sessionId", async () => {
  await withTempHome(async () => {
    const r = await allocateLane({
      owner: "agent-random-1",
      cwd: "/tmp/x",
      observations: empty,
    });
    assert.equal(r.lane.owner, "agent");
    assert.equal(r.lane.sessionId, "agent-random-1");
  });
});

test("allocateLane: five 'codex-test-NNN' calls all share owner=codex but get distinct sessions", async () => {
  await withTempHome(async () => {
    const labels = ["alpha", "bravo", "charlie", "delta", "echo"];
    const lanes = [];
    for (const l of labels) {
      const r = await allocateLane({
        owner: `codex-test-${l}`,
        cwd: "/tmp/proj",
        observations: empty,
      });
      lanes.push(r.lane);
    }
    // Same canonical owner across all lanes — what the user wants on the dashboard.
    for (const lane of lanes) assert.equal(lane.owner, "codex");
    // Each session is distinct. The full non-LLM suffix is preserved
    // (e.g. "test-alpha", not just "alpha") so distinguishing info is
    // never silently dropped.
    assert.deepEqual(
      lanes.map((l) => l.sessionId).sort(),
      ["test-alpha", "test-bravo", "test-charlie", "test-delta", "test-echo"].sort(),
    );
    // Each gets its own port and profile dir.
    assert.equal(new Set(lanes.map((l) => l.chromeDebugPort)).size, 5);
    assert.equal(new Set(lanes.map((l) => l.chromeProfileDir)).size, 5);
  });
});

test("allocateLane: same canonical+session is idempotent across raw owner variations", async () => {
  await withTempHome(async () => {
    const a = await allocateLane({ owner: "codex-test-alpha", cwd: "/tmp/x", observations: empty });
    // Different raw owner that canonicalizes to the same (codex, test-alpha) tuple
    // should resolve to the same lane.
    const b = await allocateLane({ owner: "codex", sessionId: "test-alpha", cwd: "/tmp/x", observations: empty });
    assert.equal(b.alreadyExisted, true);
    assert.equal(a.lane.id, b.lane.id);
  });
});
