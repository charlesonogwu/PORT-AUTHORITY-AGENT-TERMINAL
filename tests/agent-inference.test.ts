/**
 * Unit tests for src/dashboard/agent-inference.ts.
 *
 * The inference logic is pure given a (chromePid, port, profileDir,
 * processSnapshot) tuple, so we feed it synthetic process maps that
 * mimic what Win32_Process + Get-NetTCPConnection would return when
 * each agent is driving Chrome.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferAgentFromLiveChrome,
  walkParentChain,
  findCdpPeers,
} from "../src/dashboard/agent-inference.js";
import type { ProcessRecord, ProcessSnapshot, TcpConnection } from "../src/dashboard/process-info.js";

function snap(records: ProcessRecord[], conns: TcpConnection[] = []): ProcessSnapshot {
  const m = new Map<number, ProcessRecord>();
  for (const r of records) m.set(r.pid, r);
  return { processes: m, connections: conns };
}

function rec(pid: number, ppid: number, name: string, cmd = ""): ProcessRecord {
  return { pid, ppid, name, commandLine: cmd };
}

describe("walkParentChain", () => {
  it("walks pid → parent → grandparent", () => {
    const s = snap([
      rec(1, 0, "system"),
      rec(10, 1, "shell.exe"),
      rec(20, 10, "node.exe"),
      rec(30, 20, "chrome.exe"),
    ]);
    const chain = walkParentChain(30, s.processes, 8);
    assert.deepEqual(chain.map((r) => r.name), ["chrome.exe", "node.exe", "shell.exe", "system"]);
  });

  it("stops at maxDepth", () => {
    const s = snap([
      rec(1, 0, "a"),
      rec(2, 1, "b"),
      rec(3, 2, "c"),
      rec(4, 3, "d"),
    ]);
    const chain = walkParentChain(4, s.processes, 2);
    assert.equal(chain.length, 2);
    assert.deepEqual(chain.map((r) => r.name), ["d", "c"]);
  });

  it("stops on cycle", () => {
    // Two procs pointing at each other shouldn't loop forever.
    const s = snap([
      rec(1, 2, "a"),
      rec(2, 1, "b"),
    ]);
    const chain = walkParentChain(1, s.processes, 100);
    assert.ok(chain.length <= 2, "chain should terminate, got " + chain.length);
  });

  it("returns empty when pid not found", () => {
    const s = snap([rec(1, 0, "a")]);
    assert.deepEqual(walkParentChain(999, s.processes, 8), []);
  });
});

describe("findCdpPeers", () => {
  it("returns PIDs whose RemotePort = chrome debug port", () => {
    const conns: TcpConnection[] = [
      { localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 100 },
      { localPort: 9222, remoteAddress: "127.0.0.1", remotePort: 50000, owningPid: 999 }, // chrome's side
      { localPort: 50001, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 200 },
      { localPort: 50002, remoteAddress: "127.0.0.1", remotePort: 8080, owningPid: 300 }, // unrelated
    ];
    const peers = findCdpPeers(9222, 999, conns);
    assert.deepEqual(peers.sort(), [100, 200]);
  });

  it("excludes chrome's own PID", () => {
    const conns: TcpConnection[] = [
      { localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 999 },
    ];
    assert.deepEqual(findCdpPeers(9222, 999, conns), []);
  });

  it("excludes connections with owningPid <= 0", () => {
    const conns: TcpConnection[] = [
      { localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 0 },
    ];
    assert.deepEqual(findCdpPeers(9222, undefined, conns), []);
  });
});

describe("inferAgentFromLiveChrome — process ancestry", () => {
  it("detects codex via npx-style codex/dist path", () => {
    const s = snap([
      rec(1, 0, "system"),
      rec(10, 1, "powershell.exe"),
      rec(20, 10, "node.exe", `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\codex\\dist\\main.js"`),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "codex");
    assert.equal(r.confidence, "high");
    assert.match(r.evidence[0] ?? "", /parent-process/);
  });

  it("detects codex via @openai/codex package", () => {
    const s = snap([
      rec(20, 0, "node.exe", `node C:\\Users\\u\\.npm\\_npx\\abc\\node_modules\\@openai\\codex\\dist\\cli.js`),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "codex");
  });

  it("detects claude code via @anthropic-ai/claude-code", () => {
    const s = snap([
      rec(20, 0, "node.exe", `node C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\dist\\index.js`),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "claude");
  });

  it("detects claude code via standalone claude.exe", () => {
    const s = snap([
      rec(20, 0, "claude.exe"),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "claude");
  });

  it("detects cursor via Cursor.exe ancestor", () => {
    const s = snap([
      rec(10, 0, "Cursor.exe"),
      rec(20, 10, "Cursor.exe", "Cursor.exe --type=renderer"),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "cursor");
  });

  it("detects windsurf via Windsurf.exe ancestor", () => {
    const s = snap([
      rec(20, 0, "Windsurf.exe"),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "windsurf");
  });

  it("detects aider via python -m aider", () => {
    const s = snap([
      rec(20, 0, "python.exe", "python.exe -m aider --browser"),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "aider");
  });

  it("detects copilot via @github/copilot", () => {
    const s = snap([
      rec(20, 0, "node.exe", "node C:\\Users\\u\\.npm\\@github\\copilot\\dist\\index.js"),
      rec(30, 20, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "copilot");
  });

  it("does NOT match chrome itself even if its name fits a signature loosely", () => {
    // Chrome's own process should be skipped (chain[0]) so we don't
    // false-positive on something like a wrapper named "chrome.exe".
    const s = snap([
      rec(1, 0, "explorer.exe"),
      rec(30, 1, "chrome.exe"),
    ]);
    const r = inferAgentFromLiveChrome({ chromePid: 30, port: 9222 }, s);
    assert.equal(r.agent, "external");
    assert.equal(r.confidence, "none");
  });
});

describe("inferAgentFromLiveChrome — CDP peer", () => {
  it("detects codex via WebSocket peer when ancestry is anonymous", () => {
    // Chrome was launched by a wrapper, but Codex itself is the one
    // connected to the debug port. The peer's command line outs us.
    const s = snap(
      [
        rec(1, 0, "explorer.exe"),
        rec(20, 1, "chrome.exe"), // chrome with no agent ancestor
        rec(50, 1, "node.exe", "node C:\\codex-cli\\dist\\main.js"),
      ],
      [
        { localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 50 },
      ],
    );
    const r = inferAgentFromLiveChrome({ chromePid: 20, port: 9222 }, s);
    assert.equal(r.agent, "codex");
    assert.match(r.evidence[0] ?? "", /cdp-peer/);
  });

  it("detects agent through peer's parent (Playwright child case)", () => {
    // Codex spawns playwright (a node script) which connects to chrome.
    // Direct peer is anonymous node, but its parent is Codex.
    const s = snap(
      [
        rec(1, 0, "explorer.exe"),
        rec(10, 1, "node.exe", "node codex-cli/main.js"), // codex itself
        rec(50, 10, "node.exe", "node playwright/lib/cdp.js"), // playwright child
        rec(20, 1, "chrome.exe"),
      ],
      [
        { localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 50 },
      ],
    );
    const r = inferAgentFromLiveChrome({ chromePid: 20, port: 9222 }, s);
    assert.equal(r.agent, "codex");
    assert.match(r.evidence[0] ?? "", /cdp-peer-ancestor/);
  });
});

describe("inferAgentFromLiveChrome — profile-path fallback", () => {
  it("matches profile path keyword at medium confidence", () => {
    const s = snap([rec(20, 0, "chrome.exe")]);
    const r = inferAgentFromLiveChrome(
      { chromePid: 20, port: 9222, profileDir: "C:\\workspace\\.automation\\chrome-profile-codex" },
      s,
    );
    assert.equal(r.agent, "codex");
    assert.equal(r.confidence, "medium");
    assert.match(r.evidence[0] ?? "", /profile-path/);
  });

  it("returns external with no confidence when nothing matches", () => {
    const s = snap([rec(20, 0, "chrome.exe")]);
    const r = inferAgentFromLiveChrome(
      { chromePid: 20, port: 9222, profileDir: "C:\\some\\random\\dir" },
      s,
    );
    assert.equal(r.agent, "external");
    assert.equal(r.confidence, "none");
    assert.deepEqual(r.evidence, []);
  });

  it("works with no chromePid (agent process gone, only profile remains)", () => {
    const s = snap([]);
    const r = inferAgentFromLiveChrome(
      { chromePid: undefined, port: 9222, profileDir: "C:\\windsurf-profiles\\proj" },
      s,
    );
    assert.equal(r.agent, "windsurf");
    assert.equal(r.confidence, "medium");
  });
});

describe("inferAgentFromLiveChrome — precedence", () => {
  it("ancestry beats peer beats profile-path", () => {
    // Profile says claude. Peer says cursor. Ancestor says codex.
    // We should pick codex (highest priority signal).
    const s = snap(
      [
        rec(10, 0, "node.exe", "node codex-cli/main.js"), // ancestor: codex
        rec(20, 10, "chrome.exe"),
        rec(50, 0, "Cursor.exe"), // peer: cursor
      ],
      [{ localPort: 50000, remoteAddress: "127.0.0.1", remotePort: 9222, owningPid: 50 }],
    );
    const r = inferAgentFromLiveChrome(
      { chromePid: 20, port: 9222, profileDir: "C:\\anthropic-claude\\profile" },
      s,
    );
    assert.equal(r.agent, "codex");
  });
});
