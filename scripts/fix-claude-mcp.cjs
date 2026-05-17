#!/usr/bin/env node
/**
 * One-shot repair for every MCP host's config after the v0.2.0 npm install
 * left an empty install dir on this machine. The broken entry is the one
 * named `port-authority-agent-terminal` with `command: "paat"` — the .cmd
 * shim resolves but its require() target inside the empty install dir is
 * gone, so spawning fails with MODULE_NOT_FOUND.
 *
 * What we do per host:
 *   - Claude Desktop (%APPDATA%\Claude\claude_desktop_config.json):
 *       remove the broken entry; pin "portpilot" to node.exe + dev clone.
 *   - Codex Desktop (~/.codex/config.toml):
 *       remove the broken [mcp_servers.port-authority-agent-terminal] block.
 *       (The working [mcp_servers.portpilot] block already exists.)
 *   - Claude Code (~/.claude.json):
 *       rewrite the broken entry to use node.exe + dev clone since there's
 *       no working sibling entry to fall back on.
 *
 * Safe to re-run — idempotent. Writes a timestamped backup of every file
 * before mutating it. The TOML edit is line-based, so it preserves the
 * rest of the file (other [mcp_servers.*] blocks, comments, formatting).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const DEV_CLI = "C:\\Users\\charl\\Downloads\\portpilot\\dist\\src\\cli\\index.js";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

function backup(p) {
  const b = `${p}.bak-${STAMP}`;
  fs.copyFileSync(p, b);
  return b;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function log(...a) { console.log(...a); }

/* -------------------------------------------------------------------------- */
/*  Claude Desktop                                                            */
/* -------------------------------------------------------------------------- */
function fixClaudeDesktop() {
  const cfg = path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  if (!exists(cfg)) { log(`[claude-desktop] no config at ${cfg} — skipping`); return; }
  const b = backup(cfg);
  log(`[claude-desktop] backup: ${b}`);
  const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
  json.mcpServers = json.mcpServers || {};
  log(`[claude-desktop] before: ${Object.keys(json.mcpServers).join(", ") || "(none)"}`);
  delete json.mcpServers["port-authority-agent-terminal"];
  json.mcpServers.portpilot = { command: NODE_EXE, args: [DEV_CLI, "mcp"] };
  log(`[claude-desktop] after:  ${Object.keys(json.mcpServers).join(", ")}`);
  fs.writeFileSync(cfg, JSON.stringify(json, null, 2), "utf8");
  log(`[claude-desktop] wrote ${cfg}`);
}

/* -------------------------------------------------------------------------- */
/*  Codex Desktop (~/.codex/config.toml)                                       */
/*                                                                             */
/*  TOML edit is line-based. We strip the                                      */
/*  `[mcp_servers.port-authority-agent-terminal]` table (its header line +     */
/*  all lines until the next `[...]` header or EOF). Idempotent — re-running   */
/*  just no-ops when the block is already gone.                                */
/* -------------------------------------------------------------------------- */
function fixCodexDesktop() {
  const cfg = path.join(os.homedir(), ".codex", "config.toml");
  if (!exists(cfg)) { log(`[codex] no config at ${cfg} — skipping`); return; }
  const raw = fs.readFileSync(cfg, "utf8");
  const lines = raw.split(/\r?\n/);
  const headerRe = /^\[mcp_servers\.port-authority-agent-terminal\]\s*$/;
  const anyHeaderRe = /^\[/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    log(`[codex] no broken block in ${cfg} — already clean`);
    return;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyHeaderRe.test(lines[i])) { end = i; break; }
  }
  // Trim trailing blank lines from the removed block so we don't leave a
  // double-blank gap.
  while (end - 1 > start && lines[end - 1].trim() === "") end--;
  const b = backup(cfg);
  log(`[codex] backup: ${b}`);
  const next = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  fs.writeFileSync(cfg, next, "utf8");
  log(`[codex] removed lines ${start + 1}-${end} (the broken block)`);
}

/* -------------------------------------------------------------------------- */
/*  Claude Code (~/.claude.json)                                               */
/*                                                                             */
/*  Only has the broken entry, no working sibling. Rewrite it to use the       */
/*  same node.exe + dev clone pattern as the others.                           */
/* -------------------------------------------------------------------------- */
function fixClaudeCode() {
  const cfg = path.join(os.homedir(), ".claude.json");
  if (!exists(cfg)) { log(`[claude-code] no config at ${cfg} — skipping`); return; }
  const b = backup(cfg);
  log(`[claude-code] backup: ${b}`);
  const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
  json.mcpServers = json.mcpServers || {};
  log(`[claude-code] before: ${Object.keys(json.mcpServers).join(", ") || "(none)"}`);
  // Replace the broken paat-based entry with a working node + dev-clone one,
  // keeping the same name so existing slash-command references still resolve.
  json.mcpServers["port-authority-agent-terminal"] = {
    type: "stdio",
    command: NODE_EXE,
    args: [DEV_CLI, "mcp"],
    env: {},
  };
  log(`[claude-code] after:  ${Object.keys(json.mcpServers).join(", ")}`);
  fs.writeFileSync(cfg, JSON.stringify(json, null, 2), "utf8");
  log(`[claude-code] wrote ${cfg}`);
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */
try {
  fixClaudeDesktop();
  log("");
  fixCodexDesktop();
  log("");
  fixClaudeCode();
  log("");
  log("Done. Quit and relaunch Claude Desktop / Codex Desktop to pick up changes.");
  log("(Claude Code re-reads ~/.claude.json on the next slash-command invoke.)");
} catch (err) {
  console.error("fix-claude-mcp failed:", err && err.message ? err.message : err);
  process.exit(1);
}
