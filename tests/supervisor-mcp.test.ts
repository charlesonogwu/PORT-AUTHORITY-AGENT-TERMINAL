import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { startSupervisorServer } from "../src/supervisor/server.js";

test("MCP open delegates browser ownership to the supervisor", async () => {
  const home = await mkdtemp(join(tmpdir(), "portpilot-mcp-supervisor-"));
  const previousHome = process.env.PORTPILOT_HOME;
  process.env.PORTPILOT_HOME = home;
  await writeFile(join(home, "config.json"), JSON.stringify({
    version: 1,
    chromeDebugRange: { start: 29522, end: 29529 },
    appPortRange: { start: 29530, end: 29539 },
  }));
  const launched: string[] = [];
  const supervisor = await startSupervisorServer({
    home,
    handlers: {
      launch: async ({ laneId }) => {
        launched.push(laneId);
        return { laneId, pid: 8765, reused: false };
      },
      close: async ({ laneId }) => ({ laneId, closed: true }),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = buildMcpServer();
  const client = new Client({ name: "portpilot-test", version: "1" });
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "open",
      arguments: { owner: "codex", cwd: join(home, "project"), sessionId: "mcp-lifecycle" },
    });
    const content = (response as { content: Array<{ type: string; text?: string }> }).content;
    const text = content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    const result = JSON.parse(text.text!) as { ok: boolean; pid: number; lane: { id: string } };
    assert.equal(result.ok, true);
    assert.equal(result.pid, 8765);
    assert.deepEqual(launched, [result.lane.id]);
  } finally {
    await client.close();
    await mcp.close();
    await supervisor.close();
    if (previousHome === undefined) delete process.env.PORTPILOT_HOME;
    else process.env.PORTPILOT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
