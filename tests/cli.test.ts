import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "src", "cli", "index.js");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], home: string): RunResult {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PORTPILOT_HOME: home },
    encoding: "utf8",
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status };
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "portpilot-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("portpilot help prints usage", () => {
  const res = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /USAGE:/);
  assert.match(res.stdout, /reserve --owner/);
});

test("portpilot list on empty registry", async () => {
  await withHome(async (home) => {
    const res = runCli(["list", "--json"], home);
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.lanes, []);
  });
});

test("portpilot reserve writes registry, then list shows the lane", async () => {
  await withHome(async (home) => {
    const cwd = join(home, "myproj");
    const reserve = runCli(["reserve", "--owner", "codex", "--cwd", cwd, "--task", "ship checkout", "--json"], home);
    assert.equal(reserve.code, 0, reserve.stderr);
    const parsed = JSON.parse(reserve.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.lane.owner, "codex");
    assert.ok(typeof parsed.lane.appPort === "number");
    assert.ok(typeof parsed.lane.chromeDebugPort === "number");
    const list = runCli(["list", "--json"], home);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.lanes.length, 1);
    assert.equal(listed.lanes[0].owner, "codex");
    const raw = await readFile(join(home, "lanes.json"), "utf8");
    assert.match(raw, /"owner": "codex"/);
  });
});

test("portpilot check reports safe-free for a fresh reservation", async () => {
  await withHome(async (home) => {
    const cwd = join(home, "myproj");
    runCli(["reserve", "--owner", "codex", "--cwd", cwd, "--json"], home);
    const res = runCli(["check", "--owner", "codex", "--cwd", cwd, "--json"], home);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verdict.kind, "safe-free");
  });
});

test("portpilot release marks lane released", async () => {
  await withHome(async (home) => {
    const cwd = join(home, "myproj");
    runCli(["reserve", "--owner", "codex", "--cwd", cwd], home);
    const res = runCli(["release", "--owner", "codex", "--cwd", cwd, "--json"], home);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.released, true);
    assert.equal(parsed.lane.status, "released");
  });
});

test("portpilot next prints the next free port", async () => {
  await withHome(async (home) => {
    const res = runCli(["next", "--range", "9322-9399", "--json"], home);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.port, "number");
  });
});

test("portpilot doctor on empty registry returns ok=true", async () => {
  await withHome(async (home) => {
    const res = runCli(["doctor", "--json"], home);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.lanes.length, 0);
  });
});

test("portpilot launch-chrome --dry-run returns the planned command", async () => {
  await withHome(async (home) => {
    const cwd = join(home, "myproj");
    runCli(["reserve", "--owner", "codex", "--cwd", cwd], home);
    const res = runCli(["launch-chrome", "--owner", "codex", "--cwd", cwd, "--dry-run", "--json"], home);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.launched, false);
    assert.ok(parsed.command.args.some((a: string) => a.startsWith("--remote-debugging-port=")));
    assert.ok(parsed.command.args.some((a: string) => a.startsWith("--user-data-dir=")));
  });
});

test("unknown command exits non-zero", async () => {
  await withHome(async (home) => {
    const res = runCli(["nope"], home);
    assert.notEqual(res.code, 0);
  });
});
