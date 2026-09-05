import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, access, rename } from "node:fs/promises";
import { join } from "node:path";
import { withTempHome } from "./helpers.js";
import { profilesDir } from "../src/core/paths.js";
import { updateRegistry, listLanes, setLaneStatus, pruneReleasedLanes, removeLane } from "../src/core/registry.js";
import { forgetProfile, selectPruneCandidates, listProfiles, deleteProfileDir } from "../src/core/profiles.js";
import { allocateLane } from "../src/core/allocator.js";
import { rememberSavedLogin, findSavedLogins } from "../src/core/saved-logins.js";
import type { Lane } from "../src/core/lane.js";

async function seed(home: string, id = "lane_fixture", cwd = join(home, "workspace")): Promise<Lane> {
  const lane: Lane = { id, owner: "codex", cwd, project: "demo", sessionId: id,
    chromeProfileDir: join(profilesDir(), id), status: "active", createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
  await mkdir(lane.chromeProfileDir, { recursive: true });
  await updateRegistry(lanes => [...lanes, lane]);
  return lane;
}

test("confirmed login survives release/prune and returns exact PPID across tasks", async () => withTempHome(async home => {
  const lane = await seed(home);
  await assert.rejects(rememberSavedLogin(lane.id, { website: "example.com", confirmed: false }));
  const saved = await rememberSavedLogin(lane.id, { website: "https://EXAMPLE.com/private?token=not-stored", confirmed: true });
  assert.equal(saved.id, lane.id);
  assert.equal(saved.chromeProfileDir, lane.chromeProfileDir);
  assert.equal(saved.savedLogins?.[0]?.website, "example.com");
  assert.ok(saved.savedLogins?.[0]?.confirmedAt);
  assert.equal(JSON.stringify(saved).includes("not-stored"), false);
  await setLaneStatus(lane.id, "released");
  await pruneReleasedLanes({ all: true });
  const found = await findSavedLogins({ cwd: lane.cwd, website: "example.com" });
  assert.equal(found.reconnect?.laneId, lane.id);
  await assert.rejects(removeLane(lane.id), /saved login/i);
}));

test("website lookup rejects blank scope and never guesses among accounts or workspaces", async () => withTempHome(async home => {
  const a = await seed(home, "lane_a");
  const b = await seed(home, "lane_b");
  const c = await seed(home, "lane_c", join(home, "other"));
  for (const lane of [a,b,c]) await rememberSavedLogin(lane.id, { website: "example.com", confirmed: true });
  const found = await findSavedLogins({ cwd: a.cwd, website: "example.com" });
  assert.deepEqual(found.lanes.map(l => l.id), [a.id,b.id]);
  assert.equal(found.reconnect, null);
  assert.equal((await findSavedLogins({ cwd: a.cwd, website: "sub.example.com" })).lanes.length, 0);
  await assert.rejects(findSavedLogins({ cwd: " ", website: "example.com" }));
  await assert.rejects(rememberSavedLogin(a.id, { website: "https://user:password@example.com", confirmed: true }));
}));

test("Erase deletes login associations only for the erased profile and refuses a mismatched PPID", async () => withTempHome(async home => {
  const a = await seed(home, "lane_a"); const b = await seed(home, "lane_b");
  for (const lane of [a,b]) await rememberSavedLogin(lane.id, { website: "example.com", confirmed: true });
  await assert.rejects(forgetProfile({ profileDir: a.chromeProfileDir, laneId: b.id }));
  await assert.rejects(forgetProfile({ profileDir: a.chromeProfileDir, laneId: "lane_unknown" }));
  await access(a.chromeProfileDir);
  await forgetProfile({ profileDir: a.chromeProfileDir, laneId: a.id });
  await assert.rejects(access(a.chromeProfileDir));
  assert.deepEqual((await listLanes()).map(l => l.id), [b.id]);
  assert.equal((await findSavedLogins({ cwd: b.cwd, website: "example.com" })).reconnect?.laneId, b.id);
}));

test("missing profiles cannot be recorded or recommended", async () => withTempHome(async home => {
  const a = await seed(home);
  await rememberSavedLogin(a.id, { website: "example.com", confirmed: true });
  await updateRegistry(lanes => lanes.map(l => ({...l, chromeProfileDir: join(profilesDir(), "missing")})));
  assert.equal((await findSavedLogins({ cwd: a.cwd, website: "example.com" })).reconnect, null);
  await assert.rejects(rememberSavedLogin(a.id, { website: "example.org", confirmed: true }));
}));

test("account nicknames disambiguate, reconfirmation updates one site, and legacy labels are not login evidence", async () => withTempHome(async home => {
  const a = await seed(home, "lane_a"); const b = await seed(home, "lane_b");
  await updateRegistry(lanes => lanes.map(l => ({...l, profilePurposes: ["example-com"], profileLabel: "Example"})));
  assert.equal((await findSavedLogins({cwd: a.cwd, website: "example.com"})).lanes.length, 0);
  await rememberSavedLogin(a.id, {website: "example.com", confirmed: true, accountLabel: "Personal"});
  await rememberSavedLogin(b.id, {website: "example.com", confirmed: true, accountLabel: "Work"});
  assert.equal((await findSavedLogins({cwd: a.cwd, website: "example.com", accountLabel: "Work"})).reconnect?.laneId, b.id);
  const updated = await rememberSavedLogin(a.id, {website: "example.com", confirmed: true, accountLabel: "Secondary"});
  assert.equal(updated.savedLogins?.length, 1);
  assert.equal((await findSavedLogins({cwd: a.cwd, website: "example.com", accountLabel: "Personal"})).lanes.length, 0);
  assert.equal(selectPruneCandidates([{name: "fixture", path: a.chromeProfileDir, status: "released", sizeBytes: 0, lane: updated}], {includeReleased: true}).length, 0);
}));

test("failed Erase keeps login records and Erase without an ID cleans every matching association", async () => withTempHome(async home => {
  const a = await seed(home);
  await rememberSavedLogin(a.id, {website: "example.com", confirmed: true});
  await assert.rejects(forgetProfile({profileDir: profilesDir(), laneId: a.id}));
  assert.equal((await findSavedLogins({cwd: a.cwd, website: "example.com"})).reconnect?.laneId, a.id);
  await forgetProfile({profileDir: a.chromeProfileDir});
  assert.equal((await findSavedLogins({cwd: a.cwd, website: "example.com"})).lanes.length, 0);
}));

test("missing account remains a candidate and cannot silently select another account", async () => withTempHome(async home => {
  const a = await seed(home, "lane_a"); const b = await seed(home, "lane_b");
  for (const l of [a,b]) await rememberSavedLogin(l.id, {website: "example.com", confirmed: true});
  await updateRegistry(lanes => lanes.map(l => l.id === a.id ? {...l, chromeProfileDir: join(profilesDir(), "missing")} : l));
  const found = await findSavedLogins({cwd: a.cwd, website: "example.com"});
  assert.equal(found.lanes.length, 2);
  assert.equal(found.reconnect, null);
}));

test("all shared profile associations protect against profile pruning", async () => withTempHome(async home => {
  const a = await seed(home);
  await rememberSavedLogin(a.id, {website: "example.com", confirmed: true});
  await setLaneStatus(a.id, "released");
  await updateRegistry(lanes => [...lanes, {...a, id: "lane_duplicate", status: "stale"}]);
  assert.equal(selectPruneCandidates(await listProfiles(), {includeStale: true, includeReleased: true}).length, 0);
}));

test("new allocation cannot reuse a released saved-login directory", async () => withTempHome(async home => {
  const old = (await allocateLane({owner: "codex", cwd: join(home, "workspace"), sessionId: "fixture", observations: []})).lane;
  await mkdir(old.chromeProfileDir, {recursive:true});
  await rememberSavedLogin(old.id, {website: "example.com", confirmed: true});
  await setLaneStatus(old.id, "released");
  const next = (await allocateLane({owner: "codex", cwd: old.cwd, sessionId: "fixture", observations: []})).lane;
  assert.ok(next.id === old.id || next.chromeProfileDir !== old.chromeProfileDir);
}));

test("stale prune inventory cannot delete a subsequently confirmed login", async () => withTempHome(async home => {
  const a = await seed(home);
  await setLaneStatus(a.id, "released");
  const candidates = selectPruneCandidates(await listProfiles(), {includeReleased:true});
  assert.equal(candidates.length, 1);
  await rememberSavedLogin(a.id, {website:"example.com", confirmed:true});
  await assert.rejects(deleteProfileDir(candidates[0]!.path), /saved login/i);
  await access(a.chromeProfileDir);
}));

test("an in-progress Erase cannot be mistaken for a completed deletion", async () => withTempHome(async home => {
  const a = await seed(home);
  await rememberSavedLogin(a.id, {website:"example.com", confirmed:true});
  // State left while recursive deletion is in progress, or after a crash.
  await rename(a.chromeProfileDir, a.chromeProfileDir + ".portpilot-deleting");
  await assert.rejects(forgetProfile({profileDir:a.chromeProfileDir, laneId:a.id}), /progress|pending/i);
  assert.equal((await listLanes())[0]?.savedLogins?.length, 1);
}));
