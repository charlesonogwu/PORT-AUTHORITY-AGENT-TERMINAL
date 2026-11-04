import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { PowerShellRunner } from "../src/core/powershell-host.js";
import { createDashboardHandlers, serveDashboardRequests, type DashboardServeHandlers } from "../src/dashboard/serve.js";
import { withTempHome } from "./helpers.js";

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** Feed request lines to the server, close its input, and parse every reply line. */
async function exchange(lines: string[], handlers: DashboardServeHandlers): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { text += chunk; });
  const served = serveDashboardRequests(input, output, handlers);
  for (const line of lines) input.write(line + "\n");
  input.end();
  await withTimeout(served, 5_000, "dashboard server");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("dashboard server answers a request on one JSON line with the same id", async () => {
  const replies = await exchange(
    [JSON.stringify({ id: "1", method: "snapshot" })],
    { snapshot: async () => ({ lanes: 3 }) },
  );
  assert.deepEqual(replies, [{ id: "1", ok: true, result: { lanes: 3 } }]);
});

test("dashboard server handles requests one at a time, in arrival order", async () => {
  let active = 0;
  let maxActive = 0;
  const replies = await exchange(
    ["a", "b", "c"].map((id) => JSON.stringify({ id, method: "work" })),
    {
      work: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return null;
      },
    },
  );
  assert.deepEqual(replies.map((reply) => reply.id), ["a", "b", "c"]);
  assert.equal(maxActive, 1, "a second snapshot started before the first finished");
});

test("dashboard server reports a failing handler and keeps serving", async () => {
  const replies = await exchange(
    [JSON.stringify({ id: "1", method: "snapshot" }), JSON.stringify({ id: "2", method: "ping" })],
    {
      snapshot: async () => { throw new Error("scan failed"); },
      ping: async () => "pong",
    },
  );
  assert.deepEqual(replies, [
    { id: "1", ok: false, error: "scan failed" },
    { id: "2", ok: true, result: "pong" },
  ]);
});

test("dashboard server rejects unknown and inherited method names", async () => {
  const replies = await exchange(
    ["nope", "toString", "__proto__", "constructor"].map((method, index) => JSON.stringify({ id: String(index), method })),
    { ping: async () => "pong" },
  );
  assert.equal(replies.length, 4);
  for (const reply of replies) {
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /unknown method/);
  }
});

test("dashboard server answers malformed lines with an error instead of stopping", async () => {
  const replies = await exchange(
    [
      "not json",
      JSON.stringify({ method: "ping" }),
      JSON.stringify({ id: 7, method: "ping" }),
      JSON.stringify({ id: "x".repeat(200), method: "ping" }),
      // An object whose toString isn't callable makes String(method) throw.
      JSON.stringify({ id: "odd", method: { toString: 1 } }),
      JSON.stringify({ id: "ok", method: "ping" }),
    ],
    { ping: async () => "pong" },
  );
  assert.equal(replies.length, 6);
  for (const reply of replies.slice(0, 4)) {
    assert.equal(reply.ok, false);
    assert.equal(reply.id, null);
  }
  assert.equal(replies[4]?.id, "odd");
  assert.equal(replies[4]?.ok, false);
  assert.match(String(replies[4]?.error), /unknown method/);
  assert.deepEqual(replies[5], { id: "ok", ok: true, result: "pong" });
});

test("dashboard server survives its output pipe breaking after it stops", async () => {
  const input = new PassThrough();
  // Like a closed pipe: the failure is only reported later, asynchronously.
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(() => callback(new Error("EPIPE: broken pipe")), 20);
    },
  });
  const served = serveDashboardRequests(input, output, { ping: async () => "pong" });
  input.write(JSON.stringify({ id: "1", method: "ping" }) + "\n");
  input.end();
  await withTimeout(served, 5_000, "dashboard server");
  // An unhandled stream error here would crash the process and fail the test.
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("dashboard server stops cleanly when its input closes", async () => {
  const replies = await exchange([], { ping: async () => "pong" });
  assert.deepEqual(replies, []);
});

test("dashboard handlers return the snapshot and supervisor status in one reply", async () => {
  const runner: PowerShellRunner = { run: async () => ({ stdout: "", stderr: "", code: 0 }) };
  const sessionsSeen: unknown[] = [];
  const handlers = createDashboardHandlers({
    powershell: runner,
    buildSnapshot: async (options) => {
      sessionsSeen.push(options.powershell);
      return { summary: { liveSessions: 0 } };
    },
    supervisorStatus: async () => ({ ok: true, running: true, supervisorId: "sup-1" }),
  });
  assert.ok(handlers.snapshot, "snapshot handler missing");
  assert.ok(handlers.ping, "ping handler missing");
  assert.deepEqual(await handlers.snapshot(), {
    snapshot: { summary: { liveSessions: 0 } },
    supervisor: { ok: true, running: true, supervisorId: "sup-1" },
  });
  assert.deepEqual(sessionsSeen, [runner], "the snapshot must reuse the long-lived PowerShell session");
  assert.deepEqual(await handlers.ping(), { pid: process.pid });
});

test("dashboard-serve CLI answers ping and exits when the dashboard closes its input", async () => {
  await withTempHome(async (home) => {
    const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
    const child = spawn(process.execPath, [cli, "dashboard-serve"], {
      env: { ...process.env, PORTPILOT_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      child.stdout.setEncoding("utf8");
      const firstLine = new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline >= 0) resolve(buffer.slice(0, newline));
        });
        child.once("exit", (code) => reject(new Error(`dashboard-serve exited (${code}) before answering`)));
      });
      child.stdin.write(JSON.stringify({ id: "p1", method: "ping" }) + "\n");
      const reply = JSON.parse(await withTimeout(firstLine, 15_000, "ping reply")) as {
        id: string;
        ok: boolean;
        result: { pid: number };
      };
      assert.equal(reply.id, "p1");
      assert.equal(reply.ok, true);
      assert.equal(reply.result.pid, child.pid);

      const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
      child.stdin.end();
      const [code] = await withTimeout(exited, 10_000, "dashboard-serve exit");
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});
