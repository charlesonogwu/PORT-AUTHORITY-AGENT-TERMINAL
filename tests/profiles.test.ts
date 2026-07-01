import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempHome } from "./helpers.js";
import {
  classifyProfile,
  selectPruneCandidates,
  assertWithinProfilesRoot,
  deleteProfileDir,
  listProfiles,
  profileHasSavedData,
  forgetProfile,
  type ProfileEntry,
} from "../src/core/profiles.js";
import { profilesDir } from "../src/core/paths.js";
import { listLanes } from "../src/core/registry.js";
import { Lane, nowIso } from "../src/core/lane.js";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function lane(over: Partial<Lane>): Lane {
  return {
    id: "lane_x",
    owner: "codex",
    project: "p",
    cwd: "C:/p",
    sessionId: "default",
    chromeProfileDir: "C:/x",
    status: "active",
    createdAt: nowIso(),
    lastSeen: nowIso(),
    ...over,
  };
}

// ── classifyProfile ─────────────────────────────────────────────────────────

test("classifyProfile: orphaned when no lane references the path", () => {
  const r = classifyProfile("C:/profiles/foo", [], NOW);
  assert.equal(r.status, "orphaned");
  assert.equal(r.lane, undefined);
});

test("classifyProfile: matches by path and reports released", () => {
  const l = lane({ chromeProfileDir: "C:/profiles/foo", status: "released" });
  const r = classifyProfile("C:/profiles/foo", [l], NOW);
  assert.equal(r.status, "released");
  assert.equal(r.lane?.id, "lane_x");
});

test("classifyProfile: an active lane gone >30min reads as stale (effective status)", () => {
  const l = lane({ chromeProfileDir: "C:/profiles/foo", status: "active", lastSeen: ago(60 * 60 * 1000) });
  assert.equal(classifyProfile("C:/profiles/foo", [l], NOW).status, "stale");
});

test("classifyProfile: a freshly-seen active lane reads as active", () => {
  const l = lane({ chromeProfileDir: "C:/profiles/foo", status: "active", lastSeen: ago(1000) });
  assert.equal(classifyProfile("C:/profiles/foo", [l], NOW).status, "active");
});

// ── selectPruneCandidates ───────────────────────────────────────────────────

const P = (name: string, status: ProfileEntry["status"], lastSeen?: string): ProfileEntry => ({
  name,
  path: "C:/profiles/" + name,
  sizeBytes: 1000,
  status,
  ...(lastSeen ? { lastSeen } : {}),
});

test("selectPruneCandidates: conservative default = orphaned + released only", () => {
  const profiles = [P("a", "orphaned"), P("b", "released"), P("c", "stale"), P("d", "active"), P("e", "reserved")];
  const got = selectPruneCandidates(profiles, { includeOrphaned: true, includeReleased: true }, NOW)
    .map((p) => p.name)
    .sort();
  assert.deepEqual(got, ["a", "b"]);
});

test("selectPruneCandidates: never selects active or reserved, even if every flag is on", () => {
  const profiles = [P("d", "active"), P("e", "reserved")];
  const got = selectPruneCandidates(
    profiles,
    { includeOrphaned: true, includeReleased: true, includeStale: true },
    NOW,
  );
  assert.deepEqual(got, []);
});

test("selectPruneCandidates: --stale opt-in includes stale", () => {
  const profiles = [P("c", "stale"), P("a", "orphaned")];
  const got = selectPruneCandidates(profiles, { includeStale: true }, NOW).map((p) => p.name);
  assert.deepEqual(got, ["c"]);
});

test("selectPruneCandidates: olderThanMs excludes recently-seen", () => {
  const profiles = [P("recent", "released", ago(60 * 1000)), P("ancient", "released", ago(40 * DAY))];
  const got = selectPruneCandidates(profiles, { includeReleased: true, olderThanMs: 7 * DAY }, NOW).map((p) => p.name);
  assert.deepEqual(got, ["ancient"]);
});

test("selectPruneCandidates: names selector targets specific rooms but still spares live ones", () => {
  const profiles = [P("codex-foo", "stale"), P("codex-bar", "released"), P("codex-live", "active")];
  const got = selectPruneCandidates(profiles, { names: ["codex-foo", "codex-live"] }, NOW).map((p) => p.name);
  assert.deepEqual(got, ["codex-foo"]);
});

test("selectPruneCandidates: glob name match", () => {
  const profiles = [P("scraper-1", "orphaned"), P("scraper-2", "orphaned"), P("codex-x", "orphaned")];
  const got = selectPruneCandidates(profiles, { names: ["scraper-*"] }, NOW)
    .map((p) => p.name)
    .sort();
  assert.deepEqual(got, ["scraper-1", "scraper-2"]);
});

// ── guardrail ───────────────────────────────────────────────────────────────

test("assertWithinProfilesRoot: allows a child of the profiles dir", async () => {
  await withTempHome(async () => {
    assert.doesNotThrow(() => assertWithinProfilesRoot(join(profilesDir(), "codex-foo")));
  });
});

test("assertWithinProfilesRoot: refuses the root itself and anything outside it", async () => {
  await withTempHome(async () => {
    assert.throws(() => assertWithinProfilesRoot(profilesDir()));
    assert.throws(() => assertWithinProfilesRoot(join(profilesDir(), "..", "lanes.json")));
    assert.throws(() => assertWithinProfilesRoot("C:/Windows/System32"));
  });
});

// ── integration: listProfiles + deleteProfileDir ────────────────────────────

test("listProfiles inventories + classifies; deleteProfileDir removes only within the root", async () => {
  await withTempHome(async (home) => {
    const pdir = join(home, "profiles");
    await mkdir(join(pdir, "codex-orphan"), { recursive: true });
    await writeFile(join(pdir, "codex-orphan", "f.bin"), Buffer.alloc(2048));
    await mkdir(join(pdir, "codex-live"), { recursive: true });
    const lanes = [lane({ id: "L1", chromeProfileDir: join(pdir, "codex-live"), status: "active", lastSeen: nowIso() })];
    await writeFile(join(home, "lanes.json"), JSON.stringify({ version: 1, lanes }), "utf8");

    const list = await listProfiles();
    assert.deepEqual(list.map((p) => p.name).sort(), ["codex-live", "codex-orphan"]);
    const orphan = list.find((p) => p.name === "codex-orphan")!;
    assert.equal(orphan.status, "orphaned");
    assert.ok(orphan.sizeBytes >= 2048);
    assert.equal(list.find((p) => p.name === "codex-live")!.status, "active");

    await deleteProfileDir(orphan.path);
    assert.deepEqual(await readdir(pdir), ["codex-live"]);
  });
});

// ── profileHasSavedData ─────────────────────────────────────────────────────

test("profileHasSavedData: true when a cookie store exists, false for an empty profile", async () => {
  await withTempHome(async (home) => {
    const withData = join(home, "profiles", "codex-loggedin");
    await mkdir(join(withData, "Default", "Network"), { recursive: true });
    await writeFile(join(withData, "Default", "Network", "Cookies"), Buffer.alloc(64));
    const empty = join(home, "profiles", "codex-fresh");
    await mkdir(empty, { recursive: true });

    assert.equal(await profileHasSavedData(withData), true);
    assert.equal(await profileHasSavedData(empty), false);
  });
});

// ── forgetProfile ───────────────────────────────────────────────────────────

test("forgetProfile deletes the profile dir AND drops the lane from the registry", async () => {
  await withTempHome(async (home) => {
    const pdir = join(home, "profiles", "codex-gone");
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, "f.bin"), Buffer.alloc(128));
    const l = lane({ id: "L9", chromeProfileDir: pdir, status: "released" });
    await writeFile(join(home, "lanes.json"), JSON.stringify({ version: 1, lanes: [l] }), "utf8");

    const r = await forgetProfile({ profileDir: pdir, laneId: "L9" });
    assert.deepEqual(r, { removedProfile: true, removedLane: true });
    await assert.rejects(readdir(pdir)); // dir is gone
    assert.deepEqual(await listLanes(), []); // lane dropped
  });
});

test("forgetProfile refuses a path outside the profiles root (and keeps the lane)", async () => {
  await withTempHome(async (home) => {
    const l = lane({ id: "L10", chromeProfileDir: join(home, "profiles", "x"), status: "released" });
    await writeFile(join(home, "lanes.json"), JSON.stringify({ version: 1, lanes: [l] }), "utf8");
    await assert.rejects(forgetProfile({ profileDir: join(home, "lanes.json"), laneId: "L10" }));
    assert.equal((await listLanes()).length, 1); // lane untouched because the delete was refused
  });
});
