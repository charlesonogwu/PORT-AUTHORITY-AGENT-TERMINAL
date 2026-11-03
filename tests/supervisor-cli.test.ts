import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startSupervisorServer } from "../src/supervisor/server.js";

const execFileAsync = promisify(execFile);

test("CLI open delegates browser ownership to the supervisor", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-cli-supervisor-"));
  await writeFile(join(home, "config.json"), JSON.stringify({
    version: 1,
    chromeDebugRange: { start: 29422, end: 29429 },
    appPortRange: { start: 29430, end: 29439 },
  }));
  const launched: string[] = [];
  const server = await startSupervisorServer({
    home,
    handlers: {
      launch: async ({ laneId }) => {
        launched.push(laneId);
        return { laneId, pid: 7654, reused: false };
      },
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  try {
    const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
    const { stdout } = await execFileAsync(process.execPath, [
      cli,
      "open",
      "--owner", "codex",
      "--cwd", join(home, "project"),
      "--session", "lifecycle",
      "--json",
    ], { env: { ...process.env, PORTPILOT_HOME: home }, timeout: 15_000 });
    const result = JSON.parse(stdout) as { ok: boolean; pid: number; lane: { id: string } };
    assert.equal(result.ok, true);
    assert.equal(result.pid, 7654);
    assert.deepEqual(launched, [result.lane.id]);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
