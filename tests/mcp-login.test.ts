import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.js";

test("MCP login tools require confirmation and list uses exact owner and nonblank cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "pp-mcp-login-"));
  const previous = process.env.PORTPILOT_HOME;
  process.env.PORTPILOT_HOME = home;
  const cwd = join(home, "project");
  const lane = { id: "lane_login_one", owner: "codex", cwd, project: "project", status: "released", chromeProfileDir: join(home, "profiles", "one"), createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
  const server = buildMcpServer();
  const client = new Client({ name: "login-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) return { ok: false };
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    await mkdir(lane.chromeProfileDir, { recursive: true });
    await mkdir(lane.chromeProfileDir + "_two", { recursive: true });
    await writeFile(join(home, "lanes.json"), JSON.stringify({ version: 1, lanes: [lane, { ...lane, id: "lane_login_two", owner: "codex-custom", chromeProfileDir: lane.chromeProfileDir + "_two" }] }));
    await server.connect(b); await client.connect(a);
    assert.deepEqual((await call("list_lanes", { owner: "codex-custom" })).lanes.map((l: { id: string }) => l.id), ["lane_login_two"]);
    for (const cwd of ["", "   "]) assert.equal((await call("list_lanes", { cwd })).ok, false);
    for (const confirmed of [undefined, false, "true"]) assert.equal((await call("remember_login", { laneId: lane.id, website: "example.com", ...(confirmed === undefined ? {} : { confirmed }) })).ok, false);
    const saved = await call("remember_login", { laneId: lane.id, website: "example.com", confirmed: true, accountLabel: "Work" });
    assert.equal(saved.ok, true);
    assert.equal(saved.lane.savedLogins[0].website, "example.com");
    const found = await call("find_saved_login", { cwd, website: "example.com", accountLabel: "Work" });
    assert.equal(found.reconnect.laneId, lane.id);
    assert.equal((await call("find_saved_login", { cwd, website: "absent.example" })).ok, false);
    await call("remember_login", { laneId: "lane_login_two", website: "example.com", confirmed: true });
    const ambiguous = await call("find_saved_login", { cwd, website: "example.com" });
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.reconnect, null);
    assert.equal(ambiguous.lanes.length, 2);
    await rm(lane.chromeProfileDir, { recursive: true });
    const unavailable = await call("find_saved_login", { cwd, website: "example.com", accountLabel: "Work" });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.lanes.length, 1);
    assert.equal(unavailable.reconnect, null);
    assert.deepEqual(unavailable.unavailableProfileIds, [lane.id]);
    assert.match(unavailable.error, /saved profile unavailable/i);
    assert.match(unavailable.error, /do not create a replacement/i);
    const stillAmbiguous = await call("find_saved_login", { cwd, website: "example.com" });
    assert.equal(stillAmbiguous.ok, false);
    assert.equal(stillAmbiguous.lanes.length, 2);
    assert.equal(stillAmbiguous.reconnect, null);
    assert.match(stillAmbiguous.error, /multiple/i);
  } finally {
    await client.close(); await server.close();
    if (previous === undefined) delete process.env.PORTPILOT_HOME; else process.env.PORTPILOT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
