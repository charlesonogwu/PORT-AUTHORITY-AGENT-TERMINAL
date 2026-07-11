import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempHome } from "./helpers.js";
import { allocateLane } from "../src/core/allocator.js";
import { loadConfig, saveConfig } from "../src/core/config.js";
import { laneBrowser } from "../src/core/lane.js";

/**
 * The defaultBrowser resolution contract:
 *   1. explicit browser arg always wins
 *   2. an existing lane for (owner, cwd, session) keeps its browser
 *   3. config.defaultBrowser applies to brand-new lanes
 *   4. otherwise chrome
 */

test("config: defaultBrowser round-trips through save/load", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, defaultBrowser: "firefox" });
    const cfg = await loadConfig();
    assert.equal(cfg.defaultBrowser, "firefox");
  });
});

test("no browser arg + defaultBrowser=firefox → NEW lane is firefox", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, defaultBrowser: "firefox" });
    const r = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(laneBrowser(r.lane), "firefox");
    assert.match(r.lane.chromeProfileDir, /-firefox$/);
  });
});

test("explicit browser arg beats the default", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, defaultBrowser: "firefox" });
    const r = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "chrome", observations: [] });
    assert.equal(laneBrowser(r.lane), "chrome");
    assert.doesNotMatch(r.lane.chromeProfileDir, /-firefox$/);
  });
});

test("existing lane keeps its browser even when the default disagrees", async () => {
  await withTempHome(async () => {
    // Lane created while the default was chrome…
    const first = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(laneBrowser(first.lane), "chrome");
    // …then the user flips the default to firefox. A browser-less re-call
    // must RECONNECT to the chrome lane, not mint a firefox one.
    await saveConfig({ version: 1, defaultBrowser: "firefox" });
    const again = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(again.alreadyExisted, true);
    assert.equal(again.lane.id, first.lane.id);
    assert.equal(laneBrowser(again.lane), "chrome");
  });
});

test("no browser arg reconnects to an existing firefox lane (any-browser match)", async () => {
  await withTempHome(async () => {
    const ff = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "firefox", observations: [] });
    const again = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(again.alreadyExisted, true);
    assert.equal(again.lane.id, ff.lane.id);
    assert.equal(laneBrowser(again.lane), "firefox");
  });
});

test("when the key has lanes in several browsers, the default picks which to reuse", async () => {
  await withTempHome(async () => {
    const ch = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "chrome", observations: [] });
    const ff = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "firefox", observations: [] });
    await saveConfig({ version: 1, defaultBrowser: "firefox" });
    const pick = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(pick.lane.id, ff.lane.id);
    await saveConfig({ version: 1, defaultBrowser: "chrome" });
    const pick2 = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(pick2.lane.id, ch.lane.id);
  });
});

test("a junk defaultBrowser value in config.json falls back to chrome", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, defaultBrowser: "safari" as never });
    const r = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    assert.equal(laneBrowser(r.lane), "chrome");
  });
});

test("explicit browser still creates a second, distinct lane alongside a default-created one", async () => {
  await withTempHome(async () => {
    await saveConfig({ version: 1, defaultBrowser: "firefox" });
    const ff = await allocateLane({ owner: "codex", cwd: "/tmp/vend", observations: [] });
    const edge = await allocateLane({ owner: "codex", cwd: "/tmp/vend", browser: "edge", observations: [] });
    assert.notEqual(ff.lane.id, edge.lane.id);
    assert.equal(laneBrowser(edge.lane), "edge");
  });
});
