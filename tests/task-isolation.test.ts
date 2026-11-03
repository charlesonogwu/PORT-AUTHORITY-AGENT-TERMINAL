import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { allocateLane } from "../src/core/allocator.js";
import { listLanes } from "../src/core/registry.js";
import { resolveTaskSession, taskSessionFromEnvironment, taskSessionId } from "../src/core/task-session.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { withTempHome } from "./helpers.js";

async function connection(taskId?: string, platform: NodeJS.Platform = "darwin") {
  const server = buildMcpServer({ taskId, environment: {}, platform });
  const client = new Client({ name: "task-isolation-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    },
    async error(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      return (result.content as Array<{ text: string }>)[0]!.text;
    },
    async close() { await client.close(); await server.close(); },
  };
}

test("task identity uses the complete host ID and preserves deliberate sessions", () => {
  const prefix = "a-long-thread-id-with-more-than-forty-common-characters-";
  assert.notEqual(taskSessionId(prefix + "one"), taskSessionId(prefix + "two"));
  assert.equal(taskSessionId("same"), taskSessionId(" same "));
  assert.ok(taskSessionId("same").length < 40);
  assert.equal(taskSessionFromEnvironment({ PORTPILOT_TASK_ID: "task", CODEX_THREAD_ID: "other" }), taskSessionId("task"));
  assert.equal(taskSessionFromEnvironment({ T3CODE_THREAD_ID: "thread" }), taskSessionId("thread"));
  assert.equal(taskSessionFromEnvironment({ CLAUDE_CODE_SESSION_ID: "claude" }), taskSessionId("claude"));
  assert.equal(taskSessionFromEnvironment({ CODEX_THREAD_ID: "thread" }), taskSessionId("thread"));
  assert.equal(taskSessionFromEnvironment({ CODEX_SESSION_ID: "session" }), taskSessionId("session"));
  assert.equal(taskSessionFromEnvironment({}), undefined);
  assert.equal(resolveTaskSession("codex", undefined, "task-scope"), "task-scope");
  assert.equal(resolveTaskSession("codex", "default", "task-scope"), "task-scope");
  assert.equal(resolveTaskSession("codex", "My Explicit Task", "task-scope"), "my-explicit-task");
  assert.equal(resolveTaskSession("codex-legacy-task", undefined, "task-scope"), "legacy-task");
  assert.throws(() => resolveTaskSession("codex", undefined, undefined), /Task identity required/);
});

test("different MCP tasks isolate lanes; repeated calls and selectors stay inside their task", async () => {
  await withTempHome(async (home) => {
    const cwd = join(home, "same-project");
    const old = await allocateLane({ owner: "codex", cwd, observations: [] });
    const a = await connection("task-a");
    const b = await connection("task-b");
    const resumed = await connection("task-a");
    try {
      assert.equal((await a.call("check_lane", { owner: "codex", cwd })).ok, false, "must not select an older default lane");
      assert.equal((await a.call("list_lanes", { owner: "codex", cwd })).reconnect, null, "one unrelated lane is not a reconnect recommendation");
      const first = await a.call("reserve_lane", { owner: "codex", cwd });
      const second = await b.call("reserve_lane", { owner: "codex", cwd });
      assert.notEqual(first.lane.id, old.lane.id);
      assert.notEqual(first.lane.id, second.lane.id);
      assert.notEqual(first.lane.chromeProfileDir, second.lane.chromeProfileDir);
      assert.notEqual(first.lane.chromeDebugPort, second.lane.chromeDebugPort);
      assert.notEqual(first.lane.appPort, second.lane.appPort);
      assert.equal((await a.call("reserve_lane", { owner: "codex", cwd, sessionId: "default" })).lane.id, first.lane.id);
      assert.equal((await resumed.call("reserve_lane", { owner: "codex", cwd })).lane.id, first.lane.id);
      assert.equal((await a.call("check_lane", { owner: "codex", cwd })).lane.id, first.lane.id);
      assert.equal((await b.call("check_lane", { owner: "codex", cwd })).lane.id, second.lane.id);
      await a.call("release_lane", { owner: "codex", cwd });
      const lanes = await listLanes();
      assert.equal(lanes.find(l => l.id === first.lane.id)!.status, "released");
      assert.notEqual(lanes.find(l => l.id === second.lane.id)!.status, "released");
      assert.notEqual(lanes.find(l => l.id === old.lane.id)!.status, "released");
      assert.equal((await b.call("check_lane", { laneId: old.lane.id })).lane.id, old.lane.id, "an explicit saved PPID still works");
    } finally { await a.close(); await b.close(); await resumed.close(); }
  });
});

test("MCP without host identity requires a durable task session and reuses it after reconnect", async () => {
  await withTempHome(async (home) => {
    const a = await connection(); const b = await connection();
    const args = { owner: "codex", cwd: join(home, "project") };
    try {
      assert.match(await a.error("reserve_lane", args), /Task identity required/);
      assert.match(await b.error("open", { ...args, sessionId: "default" }), /Task identity required/);
      assert.deepEqual(await listLanes(), [], "a missing task ID must not create a browser lane");
      const first = await a.call("reserve_lane", { ...args, sessionId: "task-one" });
      const second = await b.call("reserve_lane", { ...args, sessionId: "task-two" });
      assert.notEqual(first.lane.id, second.lane.id);
      assert.equal((await b.call("reserve_lane", { ...args, sessionId: "task-one" })).lane.id, first.lane.id);
    } finally { await a.close(); await b.close(); }
  });
});

test("CLI calls inherit task isolation across processes and keep their own selectors", { skip: process.platform !== "darwin" }, async () => {
  await withTempHome(async (home) => {
    const cwd = join(home, "project");
    const cli = join(process.cwd(), "dist/src/cli/index.js");
    const run = (task: string, verb: string, extra: string[] = []) => {
      const result = spawnSync(process.execPath, [cli, verb, "--owner", "codex", "--cwd", cwd, "--json", ...extra], {
        env: { ...process.env, PORTPILOT_HOME: home, PORTPILOT_TASK_ID: task }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return JSON.parse(result.stdout);
    };
    const a = run("task-a", "reserve"); const b = run("task-b", "reserve");
    assert.notEqual(a.lane.id, b.lane.id);
    assert.notEqual(a.lane.chromeProfileDir, b.lane.chromeProfileDir);
    assert.equal(run("task-a", "reserve").lane.id, a.lane.id);
    assert.equal(run("task-a", "check").lane.id, a.lane.id);
    assert.equal(run("task-b", "check").lane.id, b.lane.id);
  });
});

test("Windows retains main's omitted-session allocation and tuple selection", async () => {
  await withTempHome(async (home) => {
    const a = await connection(undefined, "win32"); const b = await connection(undefined, "win32");
    const args = { owner: "codex", cwd: join(home, "project") };
    try {
      const first = await a.call("reserve_lane", args);
      assert.equal(first.lane.sessionId, "default");
      assert.equal((await b.call("reserve_lane", args)).lane.id, first.lane.id);
      assert.equal((await b.call("check_lane", args)).lane.id, first.lane.id);
    } finally { await a.close(); await b.close(); }
  });
});
