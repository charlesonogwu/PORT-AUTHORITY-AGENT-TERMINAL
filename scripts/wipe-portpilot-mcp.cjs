#!/usr/bin/env node
/**
 * Clean-slate sweep of portpilot/paat MCP entries from every known host
 * config file. Run BEFORE a fresh `npm install -g` so the new install's
 * postinstall can register fresh entries without colliding with stale
 * ones from previous broken installs.
 *
 * Wipes (under all known names: portpilot, paat, port-authority-agent-terminal):
 *   - %APPDATA%\Claude\claude_desktop_config.json   .mcpServers.*
 *   - ~/.codex/config.toml                          [mcp_servers.*] blocks
 *   - ~/.claude.json                                .mcpServers.*
 *
 * Backs every file up with a .bak-<timestamp> sibling before mutating.
 * Idempotent — safe to re-run.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const NAMES = ["portpilot", "paat", "port-authority-agent-terminal", "port-authority"];
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

function backup(p) {
  const b = `${p}.bak-${STAMP}`;
  fs.copyFileSync(p, b);
  return b;
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function log(...a) { console.log(...a); }

function wipeJsonConfig(cfgPath, label) {
  if (!exists(cfgPath)) { log(`[${label}] no config at ${cfgPath} — skipping`); return; }
  const raw = fs.readFileSync(cfgPath, "utf8");
  let json;
  try { json = JSON.parse(raw); } catch (e) { log(`[${label}] could not parse JSON: ${e.message}`); return; }
  json.mcpServers = json.mcpServers || {};
  const removed = [];
  for (const name of NAMES) {
    if (json.mcpServers[name]) {
      delete json.mcpServers[name];
      removed.push(name);
    }
  }
  if (removed.length === 0) {
    log(`[${label}] no portpilot/paat entries present — clean`);
    return;
  }
  const b = backup(cfgPath);
  log(`[${label}] backup: ${b}`);
  fs.writeFileSync(cfgPath, JSON.stringify(json, null, 2), "utf8");
  log(`[${label}] removed: ${removed.join(", ")}`);
}

function wipeTomlConfig(cfgPath, label) {
  if (!exists(cfgPath)) { log(`[${label}] no config at ${cfgPath} — skipping`); return; }
  const raw = fs.readFileSync(cfgPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const anyHeaderRe = /^\[/;
  const targetHeaderRes = NAMES.map((n) => new RegExp(`^\\[mcp_servers\\.${n.replace(/[.-]/g, "\\$&")}\\]\\s*$`));
  // Find all blocks to remove, sweeping back-to-front so removals don't
  // shift indices we still need to process.
  const blocks = []; // { start, end }
  for (let i = 0; i < lines.length; i++) {
    if (targetHeaderRes.some((re) => re.test(lines[i]))) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (anyHeaderRe.test(lines[j])) { end = j; break; }
      }
      while (end - 1 > i && lines[end - 1].trim() === "") end--;
      blocks.push({ start: i, end });
      i = end - 1;
    }
  }
  if (blocks.length === 0) {
    log(`[${label}] no portpilot/paat blocks present — clean`);
    return;
  }
  const b = backup(cfgPath);
  log(`[${label}] backup: ${b}`);
  for (const { start, end } of blocks.reverse()) {
    lines.splice(start, end - start);
  }
  fs.writeFileSync(cfgPath, lines.join("\n"), "utf8");
  log(`[${label}] removed ${blocks.length} block(s)`);
}

try {
  wipeJsonConfig(path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json"), "claude-desktop");
  log("");
  wipeTomlConfig(path.join(os.homedir(), ".codex", "config.toml"), "codex");
  log("");
  wipeJsonConfig(path.join(os.homedir(), ".claude.json"), "claude-code");
  log("");
  log("Done. All known portpilot/paat MCP entries removed across all hosts.");
} catch (err) {
  console.error("wipe-portpilot-mcp failed:", err && err.message ? err.message : err);
  process.exit(1);
}
