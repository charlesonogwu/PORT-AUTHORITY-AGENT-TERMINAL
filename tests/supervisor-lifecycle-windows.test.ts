import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSupervisorClient } from "../src/supervisor/client.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try { return await fn(); } catch (error) { last = error; }
    await delay(50);
  }
  throw last instanceof Error ? last : new Error("condition timed out");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("supervised process survives controller termination and reconnects", { skip: process.platform !== "win32" && "requires Windows process lifecycle" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-lifecycle-"));
  const resultPath = join(home, "controller-result.json");
  const supervisorScript = fileURLToPath(new URL("./fixtures/supervisor-worker.js", import.meta.url));
  const controllerScript = fileURLToPath(new URL("./fixtures/supervisor-controller.js", import.meta.url));
  const supervisor = spawn(process.execPath, [supervisorScript, home], { stdio: "ignore", windowsHide: true });
  let childPid = 0;
  try {
    const client = createSupervisorClient({ home, timeoutMs: 500 });
    await waitFor(() => client.ping());

    const controller = spawn(process.execPath, [controllerScript, home, resultPath], { stdio: "ignore", windowsHide: true });
    await waitFor(async () => { await access(resultPath); return true; });
    childPid = JSON.parse(await readFile(resultPath, "utf8")).pid as number;
    assert.ok(alive(childPid), "synthetic supervised child should be alive before controller termination");

    controller.kill();
    await waitFor(async () => {
      if (controller.exitCode === null) throw new Error("controller still running");
      return true;
    });

    assert.ok(alive(childPid), "controller exit must not terminate the supervised child");
    const reconnected = await client.launch({ laneId: "synthetic-lane" });
    assert.equal(reconnected.pid, childPid);
    assert.equal(reconnected.reused, true);

    const closed = await client.close({ laneId: "synthetic-lane" });
    assert.equal(closed.closed, true);
    await waitFor(async () => {
      if (alive(childPid)) throw new Error("child still running");
      return true;
    });
  } finally {
    if (childPid && alive(childPid)) process.kill(childPid);
    supervisor.kill();
    await rm(home, { recursive: true, force: true });
  }
});
