import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flagBool, parseArgs } from "../src/cli/args.js";

test("only purpose accumulates; repeated dry-run uses its final scalar", () => {
  const args = parseArgs(["open", "--dry-run=false", "--dry-run=true", "--purpose=a", "--purpose=b"]);
  assert.equal(flagBool(args, "dry-run"), true);
  assert.equal(args.flags["dry-run"], "true");
  assert.deepEqual(args.flags.purpose, ["a", "b"]);
});

test("CLI saved login confirmation, discovery, ambiguity and list safety", async () => {
  const home = await mkdtemp(join(tmpdir(), "pp-cli-login-"));
  const cwd = join(home, "project");
  const id = "lane_immutable_ppid_long_enough_to_never_truncate_12345";
  const lane = { id, owner: "codex", cwd, project: "project", status: "released", chromeProfileDir: join(home, "profiles", id), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { cwd: process.cwd(), env: { ...process.env, PORTPILOT_HOME: home }, encoding: "utf8" });
  try {
    await mkdir(lane.chromeProfileDir, { recursive: true });
    await mkdir(lane.chromeProfileDir + "_two", { recursive: true });
    await writeFile(join(home, "lanes.json"), JSON.stringify({ version: 1, lanes: [lane, { ...lane, id: id + "_two", chromeProfileDir: lane.chromeProfileDir + "_two" }] }));
    assert.ok(run("list").stdout.includes(id));
    for (const blank of ["", "   "]) assert.notEqual(run("list", "--cwd=" + blank, "--json").status, 0);
    const missing = run("remember-login", "--lane-id", id, "--website", "example.com", "--json");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /confirm/i);
    const saved = run("remember-login", "--lane-id", id, "--website", "https://Example.com:8443/path", "--confirmed", "--account-label", "Work", "--json");
    assert.equal(saved.status, 0, saved.stdout + saved.stderr);
    assert.equal(JSON.parse(saved.stdout).lane.savedLogins[0].website, "example.com:8443");
    const found = run("find-login", "--cwd", cwd, "--website", "example.com:8443", "--json");
    assert.equal(found.status, 0, found.stdout + found.stderr);
    assert.equal(JSON.parse(found.stdout).reconnect.laneId, id);
    assert.notEqual(run("find-login", "--cwd", cwd, "--website", "absent.example", "--json").status, 0);
    assert.equal(run("remember-login", "--lane-id", id + "_two", "--website", "example.com:8443", "--confirmed", "--json").status, 0);
    const ambiguous = JSON.parse(run("find-login", "--cwd", cwd, "--website", "example.com:8443", "--json").stdout);
    assert.equal(ambiguous.reconnect, null);
    assert.equal(ambiguous.lanes.length, 2);
    assert.equal(ambiguous.ok, false);
    // A missing synthetic profile must remain a candidate, never select its sibling.
    await rm(lane.chromeProfileDir, { recursive: true });
    const unavailableRun = run("find-login", "--cwd", cwd, "--website", "example.com:8443", "--account-label", "Work", "--json");
    const unavailable = JSON.parse(unavailableRun.stdout);
    assert.notEqual(unavailableRun.status, 0);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.lanes.length, 1);
    assert.equal(unavailable.reconnect, null);
    assert.deepEqual(unavailable.unavailableProfileIds, [id]);
    assert.match(unavailable.error, /saved profile unavailable/i);
    assert.match(unavailable.error, /do not create a replacement/i);
    const stillAmbiguous = JSON.parse(run("find-login", "--cwd", cwd, "--website", "example.com:8443", "--json").stdout);
    assert.equal(stillAmbiguous.lanes.length, 2);
    assert.equal(stillAmbiguous.reconnect, null);
    assert.equal(stillAmbiguous.ok, false);
    assert.match(stillAmbiguous.error, /multiple/i);
  } finally { await rm(home, { recursive: true, force: true }); }
});
