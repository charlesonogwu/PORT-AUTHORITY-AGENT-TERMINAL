#!/usr/bin/env node
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { allocateLane, checkLane, findFreePort } from "../core/allocator.js";
import { Lane, isStale, normalizeCwd, nowIso } from "../core/lane.js";
import { DEFAULT_PRUNE_AGE_MS, findLane, listLanes, markStaleLanes, pruneReleasedLanes, removeLane, setLaneStatus, touchLane, updateRegistry } from "../core/registry.js";
import { scanPorts, hasSonar } from "../core/scanner.js";
import { evaluateChromeAttach, launchChromeForLane, resolveChromeMode } from "../core/chrome.js";
import { portpilotHome, profilesDir, registryPath } from "../core/paths.js";
import { deleteProfileDir, forgetProfile, listProfiles, selectPruneCandidates, type ProfilePruneOptions } from "../core/profiles.js";
import { configForMachine, configPath, loadConfig, saveConfig, recommendForMachine } from "../core/config.js";
import { installShortcut, shortcutStatus, uninstallShortcut } from "./shortcut.js";
import { installMcpFor, type McpClient } from "./install-mcp.js";
import { formatMissingDependencyMessage, isMissingDependencyError, missingDependencyName } from "./mcp-preflight.js";
import { ParsedArgs, flagBool, flagString, parseArgs, parseDurationMs, parsePortRange } from "./args.js";
import { formatLanesTable, formatReserveBlock } from "./format.js";
import { HELP } from "./help.js";

interface CliContext {
  args: ParsedArgs;
  json: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function fail(ctx: CliContext, message: string, code = 1): never {
  if (ctx.json) ctx.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  else ctx.stderr.write(`portpilot: ${message}\n`);
  process.exit(code);
}

function emit(ctx: CliContext, payload: unknown): void {
  ctx.stdout.write(JSON.stringify(payload, null, ctx.json ? 2 : 0) + "\n");
}

function requireOwnerCwd(ctx: CliContext): { owner: string; cwd: string } {
  const owner = flagString(ctx.args, "owner");
  const cwd = flagString(ctx.args, "cwd");
  if (!owner) fail(ctx, "missing required --owner");
  if (!cwd) fail(ctx, "missing required --cwd");
  return { owner: owner!, cwd: normalizeCwd(cwd!) };
}

async function cmdList(ctx: CliContext): Promise<void> {
  const lanes = await listLanes();
  if (ctx.json) {
    emit(ctx, { ok: true, lanes });
    return;
  }
  if (lanes.length === 0) {
    ctx.stdout.write("No lanes registered.\n");
    return;
  }
  ctx.stdout.write(formatLanesTable(lanes) + "\n");
}

async function cmdStatus(ctx: CliContext): Promise<void> {
  await markStaleLanes();
  const lanes = await listLanes();
  const scan = await scanPorts();
  const sonar = await hasSonar().catch(() => false);
  const warnings: { laneId: string; message: string }[] = [];
  for (const lane of lanes) {
    if (lane.status === "released") continue;
    const verdict = evaluateChromeAttach(lane, scan.observations);
    if (verdict.kind === "unsafe-foreign-chrome" || verdict.kind === "unsafe-unknown") {
      warnings.push({ laneId: lane.id, message: `Chrome port ${lane.chromeDebugPort} held by foreign process` });
    }
    if (isStale(lane)) {
      warnings.push({ laneId: lane.id, message: `Lane has not checked in recently (lastSeen=${lane.lastSeen})` });
    }
  }
  if (ctx.json) {
    emit(ctx, {
      ok: true,
      sonarAvailable: sonar,
      scanSource: scan.source,
      scanErrors: scan.errors,
      lanes,
      observations: scan.observations,
      warnings,
    });
    return;
  }
  ctx.stdout.write(`Storage:        ${registryPath()}\n`);
  ctx.stdout.write(`Sonar:          ${sonar ? "available" : "not found (using native fallback)"}\n`);
  ctx.stdout.write(`Scan source:    ${scan.source}\n`);
  if (scan.errors.length) ctx.stdout.write(`Scan errors:    ${scan.errors.join("; ")}\n`);
  ctx.stdout.write("\nLanes:\n");
  if (lanes.length === 0) ctx.stdout.write("  (none)\n");
  else ctx.stdout.write(formatLanesTable(lanes) + "\n");
  if (warnings.length > 0) {
    ctx.stdout.write("\nWarnings:\n");
    for (const w of warnings) ctx.stdout.write(`  - ${w.laneId}: ${w.message}\n`);
  }
}

async function cmdReserve(ctx: CliContext): Promise<void> {
  const { owner, cwd } = requireOwnerCwd(ctx);
  const sessionId = flagString(ctx.args, "session");
  const task = flagString(ctx.args, "task");
  const browserScript = flagString(ctx.args, "browser-script");
  const appRange = parsePortRange(flagString(ctx.args, "app-range"));
  const chromeRange = parsePortRange(flagString(ctx.args, "chrome-range"));
  const withApp = !flagBool(ctx.args, "no-app-port", false);
  const withChrome = !flagBool(ctx.args, "no-chrome-port", false);
  const result = await allocateLane({
    owner,
    cwd,
    sessionId,
    task,
    browserScript,
    appPortRange: appRange,
    chromeDebugRange: chromeRange,
    withAppPort: withApp,
    withChromePort: withChrome,
  });
  await mkdir(result.lane.chromeProfileDir, { recursive: true }).catch(() => {});
  if (ctx.json) {
    emit(ctx, { ok: true, alreadyExisted: result.alreadyExisted, lane: result.lane });
    return;
  }
  ctx.stdout.write(formatReserveBlock(result.lane) + "\n");
  if (result.alreadyExisted) ctx.stdout.write("\n(reused existing reservation)\n");
}

async function cmdCheck(ctx: CliContext): Promise<void> {
  const { owner, cwd } = requireOwnerCwd(ctx);
  const sessionId = flagString(ctx.args, "session");
  const lane = await findLane({ owner, cwd, ...(sessionId ? { sessionId } : {}) });
  if (!lane) fail(ctx, `no lane found for owner=${owner} cwd=${cwd}${sessionId ? ` session=${sessionId}` : ""}. Run: portpilot reserve --owner ${owner} --cwd ${cwd}${sessionId ? ` --session ${sessionId}` : ""}`, 2);
  await touchLane(lane!.id);
  const result = await checkLane(lane!);
  const verdict = result.verdict;
  const safe = verdict.kind === "safe-free" || verdict.kind === "safe-attach";
  if (safe && lane!.status === "reserved") {
    await setLaneStatus(lane!.id, "active");
  }
  if (ctx.json) {
    emit(ctx, { ok: safe, verdict, lane, appPortInUse: result.appPortInUse, scanSource: result.scanSource, scanErrors: result.scanErrors });
    if (!safe) process.exit(3);
    return;
  }
  ctx.stdout.write(`Lane ${lane!.id} (${lane!.owner} / ${lane!.project})\n`);
  ctx.stdout.write(`  Chrome debug port:   ${lane!.chromeDebugPort ?? "(none)"}\n`);
  ctx.stdout.write(`  Chrome profile dir:  ${lane!.chromeProfileDir}\n`);
  ctx.stdout.write(`  App port:            ${lane!.appPort ?? "(none)"} ${result.appPortInUse ? "[in use]" : "[free]"}\n`);
  ctx.stdout.write(`  Verdict:             ${verdict.kind}\n`);
  if (verdict.kind === "unsafe-foreign-chrome") {
    ctx.stdout.write(`  Found profile:       ${verdict.foundProfile ?? "(none)"}\n`);
    ctx.stdout.write(`  Foreign command:     ${verdict.observation.command ?? "?"} (pid=${verdict.observation.pid ?? "?"})\n`);
    ctx.stdout.write(`\nDO NOT attach. Another agent owns this Chrome instance.\n`);
    process.exit(3);
  }
  if (verdict.kind === "unsafe-unknown") {
    ctx.stdout.write(`  Foreign command:     ${verdict.observation.command ?? "?"} (pid=${verdict.observation.pid ?? "?"})\n`);
    ctx.stdout.write(`\nDO NOT attach. Port is held by a non-Chrome process.\n`);
    process.exit(3);
  }
  if (verdict.kind === "safe-free") ctx.stdout.write(`  Status:              port is free, you may launch Chrome.\n`);
  if (verdict.kind === "safe-attach") ctx.stdout.write(`  Status:              your Chrome is already running, you may attach.\n`);
}

async function cmdRelease(ctx: CliContext): Promise<void> {
  const { owner, cwd } = requireOwnerCwd(ctx);
  const sessionId = flagString(ctx.args, "session");
  const lane = await findLane({ owner, cwd, ...(sessionId ? { sessionId } : {}), includeReleased: true });
  if (!lane) fail(ctx, `no lane found for owner=${owner} cwd=${cwd}${sessionId ? ` session=${sessionId}` : ""}`, 2);
  if (flagBool(ctx.args, "remove")) {
    await removeLane(lane!.id);
    if (ctx.json) emit(ctx, { ok: true, removed: true, laneId: lane!.id });
    else ctx.stdout.write(`Removed lane ${lane!.id}.\n`);
    return;
  }
  const updated = await setLaneStatus(lane!.id, "released");
  if (ctx.json) emit(ctx, { ok: true, released: true, lane: updated });
  else ctx.stdout.write(`Released lane ${lane!.id}. (Chrome was NOT killed; close it yourself if needed.)\n`);
}

async function cmdNext(ctx: CliContext): Promise<void> {
  const range = parsePortRange(flagString(ctx.args, "range"));
  const port = await findFreePort({ range });
  if (port === undefined) fail(ctx, "no free port in range", 4);
  if (ctx.json) emit(ctx, { ok: true, port });
  else ctx.stdout.write(String(port) + "\n");
}

async function cmdDoctor(ctx: CliContext): Promise<void> {
  await markStaleLanes();
  const lanes = await listLanes();
  const scan = await scanPorts();
  const sonar = await hasSonar().catch(() => false);
  type Issue = { laneId?: string; severity: "info" | "warn" | "error"; message: string; suggestion?: string };
  const issues: Issue[] = [];
  if (!sonar) issues.push({ severity: "info", message: "Sonar not installed; using native port scan. Install Sonar for richer process info." });
  if (scan.source === "empty") issues.push({ severity: "error", message: "Could not run any port scanner.", suggestion: "Install lsof / ss on Unix, or ensure powershell.exe is available on Windows." });
  for (const lane of lanes) {
    if (lane.status === "released") continue;
    const verdict = evaluateChromeAttach(lane, scan.observations);
    if (verdict.kind === "unsafe-foreign-chrome") {
      issues.push({
        laneId: lane.id,
        severity: "error",
        message: `Chrome debug port ${lane.chromeDebugPort} is held by Chrome with profile "${verdict.foundProfile ?? "unknown"}", which does not match this lane.`,
        suggestion: `Close the foreign Chrome instance, or release this lane: portpilot release --owner ${lane.owner} --cwd ${JSON.stringify(lane.cwd)}`,
      });
    }
    if (verdict.kind === "unsafe-unknown") {
      issues.push({
        laneId: lane.id,
        severity: "error",
        message: `Chrome debug port ${lane.chromeDebugPort} is held by ${verdict.observation.command ?? "an unknown process"} (pid=${verdict.observation.pid ?? "?"}).`,
        suggestion: `Reassign this lane to a free port: portpilot release --owner ${lane.owner} --cwd ${JSON.stringify(lane.cwd)} && portpilot reserve --owner ${lane.owner} --cwd ${JSON.stringify(lane.cwd)}`,
      });
    }
    if (lane.status === "stale") {
      issues.push({
        laneId: lane.id,
        severity: "warn",
        message: `Lane ${lane.id} is stale (lastSeen=${lane.lastSeen}).`,
        suggestion: `If the agent is no longer running, release it: portpilot release --owner ${lane.owner} --cwd ${JSON.stringify(lane.cwd)}`,
      });
    }
  }
  // Detect duplicate Chrome ports across lanes
  const seen = new Map<number, string[]>();
  for (const lane of lanes) {
    if (lane.status === "released") continue;
    if (typeof lane.chromeDebugPort !== "number") continue;
    const arr = seen.get(lane.chromeDebugPort) ?? [];
    arr.push(lane.id);
    seen.set(lane.chromeDebugPort, arr);
  }
  for (const [port, ids] of seen) {
    if (ids.length > 1) {
      issues.push({
        severity: "error",
        message: `Multiple lanes claim Chrome debug port ${port}: ${ids.join(", ")}.`,
        suggestion: "This should not happen. Release all but one and re-reserve.",
      });
    }
  }
  // Suggest prune when there are many old released entries — released
  // lanes are paperwork; if the registry has > 10 of them, a prune helps.
  const released = lanes.filter((l) => l.status === "released");
  if (released.length > 10) {
    issues.push({
      severity: "info",
      message: `${released.length} released lanes in registry (paperwork only — they don't claim ports).`,
      suggestion: "portpilot prune --all   (preview with --dry-run first)",
    });
  }
  if (ctx.json) {
    emit(ctx, { ok: issues.every((i) => i.severity !== "error"), home: portpilotHome(), profilesDir: profilesDir(), sonarAvailable: sonar, scanSource: scan.source, lanes, issues });
    return;
  }
  ctx.stdout.write(`Home:           ${portpilotHome()}\n`);
  ctx.stdout.write(`Profiles dir:   ${profilesDir()}\n`);
  ctx.stdout.write(`Sonar:          ${sonar ? "available" : "not installed"}\n`);
  ctx.stdout.write(`Scan source:    ${scan.source}\n`);
  ctx.stdout.write(`Lanes:          ${lanes.length}\n\n`);
  if (issues.length === 0) {
    ctx.stdout.write("No issues found.\n");
    return;
  }
  for (const i of issues) {
    const tag = i.severity === "error" ? "[ERROR]" : i.severity === "warn" ? "[WARN] " : "[INFO] ";
    ctx.stdout.write(`${tag} ${i.message}\n`);
    if (i.suggestion) ctx.stdout.write(`        suggested: ${i.suggestion}\n`);
  }
  ctx.stdout.write("\nNo destructive action was taken. portpilot will never kill processes automatically.\n");
}

async function cmdLaunchChrome(ctx: CliContext): Promise<void> {
  const { owner, cwd } = requireOwnerCwd(ctx);
  const sessionId = flagString(ctx.args, "session");
  const lane = await findLane({ owner, cwd, ...(sessionId ? { sessionId } : {}) });
  if (!lane) fail(ctx, `no lane found for owner=${owner} cwd=${cwd}${sessionId ? ` session=${sessionId}` : ""}. Run reserve first.`, 2);
  const result = await checkLane(lane!);
  if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
    fail(ctx, `unsafe to launch Chrome: ${result.verdict.kind}. Run portpilot doctor for details.`, 3);
  }
  if (result.verdict.kind === "safe-attach") {
    if (ctx.json) emit(ctx, { ok: true, attached: true, lane });
    else ctx.stdout.write(`Chrome already running on port ${lane!.chromeDebugPort} with the matching profile. Attach instead.\n`);
    return;
  }
  const dryRun = flagBool(ctx.args, "dry-run");
  const bin = flagString(ctx.args, "bin");
  // --mode wins, then PORTPILOT_CHROME_MODE env, then config, then "visible".
  const cfg = await loadConfig();
  const mode = resolveChromeMode(flagString(ctx.args, "mode"), cfg.chromeMode);
  const launch = await launchChromeForLane(lane!, { dryRun, binaryPath: bin, mode });
  await updateRegistry((lanes) => lanes.map((l) => (l.id === lane!.id ? { ...l, status: "active", lastSeen: nowIso(), pid: launch.pid ?? l.pid } : l)));
  if (ctx.json) emit(ctx, { ok: true, launched: !dryRun, mode, lane, command: { binary: launch.binary, args: launch.args }, pid: launch.pid });
  else {
    if (dryRun) ctx.stdout.write(`Would launch (${mode}): ${launch.binary} ${launch.args.join(" ")}\n`);
    else ctx.stdout.write(`Launched ${launch.binary} (pid=${launch.pid ?? "?"}, mode=${mode})\nDebug port: ${lane!.chromeDebugPort}\nProfile:    ${lane!.chromeProfileDir}\n`);
  }
}

async function cmdConfig(ctx: CliContext): Promise<void> {
  const sub = ctx.args.positional[0] ?? "show";
  switch (sub) {
    case "show": {
      const cfg = await loadConfig();
      if (ctx.json) {
        emit(ctx, { ok: true, path: configPath(), config: cfg });
      } else {
        ctx.stdout.write(`Config file:    ${configPath()}\n`);
        ctx.stdout.write(`maxActiveLanes:    ${cfg.maxActiveLanes ?? "(unlimited)"}\n`);
        ctx.stdout.write(`warnAtActiveLanes: ${cfg.warnAtActiveLanes ?? "(disabled)"}\n`);
        ctx.stdout.write(`chromeDebugRange:  ${cfg.chromeDebugRange ? `${cfg.chromeDebugRange.start}-${cfg.chromeDebugRange.end}` : "(default)"}\n`);
        ctx.stdout.write(`appPortRange:      ${cfg.appPortRange ? `${cfg.appPortRange.start}-${cfg.appPortRange.end}` : "(default)"}\n`);
      }
      return;
    }
    case "recommend": {
      const rec = recommendForMachine();
      if (ctx.json) {
        emit(ctx, { ok: true, recommendation: rec });
      } else {
        ctx.stdout.write(`Total RAM:                  ${rec.totalRamGb} GB\n`);
        ctx.stdout.write(`Recommended maxActiveLanes: ${rec.recommendedMaxActiveLanes}\n`);
        ctx.stdout.write(`Recommended warnAt:         ${rec.recommendedWarnAtActiveLanes}\n`);
        ctx.stdout.write(`Reasoning:                  ${rec.reasoning}\n`);
      }
      return;
    }
    case "init": {
      const force = flagBool(ctx.args, "force");
      const current = force ? { version: 1 as const } : await loadConfig();
      const { config, recommendation } = configForMachine(current);
      await saveConfig(config);
      if (ctx.json) {
        emit(ctx, { ok: true, path: configPath(), config, recommendation });
      } else {
        ctx.stdout.write(`Wrote ${configPath()}\n\n`);
        ctx.stdout.write(`maxActiveLanes:    ${config.maxActiveLanes}\n`);
        ctx.stdout.write(`warnAtActiveLanes: ${config.warnAtActiveLanes}\n`);
        ctx.stdout.write(`chromeDebugRange:  ${config.chromeDebugRange!.start}-${config.chromeDebugRange!.end}\n`);
        ctx.stdout.write(`appPortRange:      ${config.appPortRange!.start}-${config.appPortRange!.end}\n\n`);
        ctx.stdout.write(`Tuning rationale:\n  ${recommendation.reasoning}\n`);
      }
      return;
    }
    case "set": {
      const key = ctx.args.positional[1];
      const value = ctx.args.positional[2];
      if (!key || value === undefined) fail(ctx, "usage: portpilot config set <key> <value>", 1);
      const cfg = await loadConfig();
      const next: Record<string, unknown> = { ...cfg };
      if (key === "maxActiveLanes" || key === "warnAtActiveLanes") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) fail(ctx, `${key} must be a non-negative integer`, 1);
        next[key] = n;
      } else if (key === "chromeDebugRange" || key === "appPortRange") {
        const m = /^(\d+)-(\d+)$/.exec(value!);
        if (!m) fail(ctx, `${key} must be like 9322-9399`, 1);
        next[key] = { start: Number(m[1]), end: Number(m[2]) };
      } else {
        fail(ctx, `unknown key '${key}'. Allowed: maxActiveLanes, warnAtActiveLanes, chromeDebugRange, appPortRange`, 1);
      }
      next.version = 1;
      await saveConfig(next as unknown as Parameters<typeof saveConfig>[0]);
      if (ctx.json) emit(ctx, { ok: true, key, value: next[key] });
      else ctx.stdout.write(`Set ${key} = ${JSON.stringify(next[key])} in ${configPath()}\n`);
      return;
    }
    case "path": {
      if (ctx.json) emit(ctx, { ok: true, path: configPath() });
      else ctx.stdout.write(configPath() + "\n");
      return;
    }
    default:
      fail(ctx, `unknown 'config' subcommand: ${sub}. Try: show, recommend, init [--force], set <key> <value>, path`, 1);
  }
}

async function cmdPrune(ctx: CliContext): Promise<void> {
  const dryRun = flagBool(ctx.args, "dry-run");
  const all = flagBool(ctx.args, "all");
  const olderThanRaw = flagString(ctx.args, "older-than");
  let olderThanMs: number | undefined;
  if (olderThanRaw) {
    olderThanMs = parseDurationMs(olderThanRaw);
    if (olderThanMs === undefined) fail(ctx, `invalid --older-than "${olderThanRaw}". Use e.g. 30m, 24h, 7d`, 1);
  }
  const opts: Parameters<typeof pruneReleasedLanes>[0] = { dryRun };
  if (all) opts.all = true;
  else if (olderThanMs !== undefined) opts.olderThanMs = olderThanMs;
  const result = await pruneReleasedLanes(opts);
  if (ctx.json) {
    emit(ctx, {
      ok: true,
      dryRun,
      all,
      olderThanMs: opts.all ? null : (opts.olderThanMs ?? DEFAULT_PRUNE_AGE_MS),
      candidates: result.candidates,
      pruned: result.pruned,
    });
    return;
  }
  if (dryRun) {
    if (result.candidates.length === 0) {
      ctx.stdout.write("No released lanes match. Nothing to prune.\n");
      return;
    }
    ctx.stdout.write(`Would prune ${result.candidates.length} released lane(s):\n`);
    for (const l of result.candidates) {
      ctx.stdout.write(`  - ${l.id}  ${l.owner}/${l.project}  port=${l.chromeDebugPort ?? "-"}  releasedAt=${l.lastSeen}\n`);
    }
    ctx.stdout.write(`\nRe-run without --dry-run to actually remove these.\n`);
    return;
  }
  if (result.pruned.length === 0) {
    ctx.stdout.write("No released lanes pruned.\n");
    return;
  }
  ctx.stdout.write(`Pruned ${result.pruned.length} released lane(s).\n`);
}

async function cmdShortcut(ctx: CliContext): Promise<void> {
  const sub = ctx.args.positional[0] ?? "status";
  if (sub === "install") {
    if (process.platform !== "win32") fail(ctx, "portpilot shortcut is currently Windows-only.", 1);
    const portStr = flagString(ctx.args, "port");
    const port = portStr ? Number(portStr) : undefined;
    if (portStr && (!Number.isInteger(port) || (port as number) <= 0)) fail(ctx, `invalid --port: ${portStr}`, 1);
    try {
      const paths = await installShortcut({
        ...(port !== undefined && { port }),
        ...(flagString(ctx.args, "icon") ? { iconLocation: flagString(ctx.args, "icon")! } : {}),
      });
      if (ctx.json) emit(ctx, { ok: true, ...paths });
      else {
        ctx.stdout.write(`Installed desktop shortcut.\n\n`);
        ctx.stdout.write(`  shortcut: ${paths.shortcut}\n`);
        ctx.stdout.write(`  launcher: ${paths.launcher}\n\n`);
        ctx.stdout.write(`Double-click the shortcut to open the dashboard.\n`);
        ctx.stdout.write(`The launcher auto-starts the server in a hidden window if it isn't already running.\n`);
      }
    } catch (err) {
      fail(ctx, (err as Error).message, 1);
    }
    return;
  }
  if (sub === "uninstall") {
    const r = await uninstallShortcut();
    if (ctx.json) emit(ctx, { ok: true, ...r });
    else ctx.stdout.write(`Uninstalled${r.removedShortcut ? "" : " (shortcut was already absent)"}.\n`);
    return;
  }
  if (sub === "status" || sub === "show") {
    const s = await shortcutStatus();
    if (ctx.json) emit(ctx, { ok: true, ...s });
    else {
      ctx.stdout.write(`shortcut: ${s.shortcutExists ? "installed" : "NOT installed"}  (${s.shortcut})\n`);
      ctx.stdout.write(`launcher: ${s.launcherExists ? "installed" : "NOT installed"}  (${s.launcher})\n`);
    }
    return;
  }
  fail(ctx, `unknown 'shortcut' subcommand: ${sub}. Try: install, uninstall, status`, 1);
}

/**
 * `paat dashboard` — spawn the native Tauri dashboard binary.
 *
 * As of v0.2.0 the dashboard is a real Tauri app (WebView2 / WKWebView),
 * not an Express server + Chrome --app=. No port binding, no localhost,
 * no remote-attack-surface concerns. The legacy --port / --host /
 * --allow-remote flags are accepted but ignored (with a warning) so we
 * don't break scripts upgrading from v0.1.x.
 */
async function cmdDashboard(ctx: CliContext): Promise<void> {
  const legacyPort = flagString(ctx.args, "port");
  const legacyHost = flagString(ctx.args, "host");
  const legacyAllowRemote = flagBool(ctx.args, "allow-remote", false);
  if (legacyPort || legacyHost || legacyAllowRemote) {
    ctx.stderr.write(
      "[paat] note: --port / --host / --allow-remote are no-ops since v0.2.0. " +
        "The dashboard is now a native Tauri app — there's no HTTP server to bind.\n",
    );
  }
  const { launchDashboard } = await import("../dashboard/launch.js");
  const result = await launchDashboard();
  if (!result.ok) {
    if (ctx.json) {
      emit(ctx, { ok: false, error: result.error });
      process.exit(1);
    }
    fail(ctx, result.error ?? "failed to launch dashboard", 1);
  }
  if (ctx.json) {
    emit(ctx, { ok: true, binary: result.binary, pid: result.pid });
  } else {
    ctx.stdout.write(`portpilot dashboard launched (pid ${result.pid}).\n`);
    ctx.stdout.write(`binary: ${result.binary}\n`);
  }
  // The child is detached + unref'd, so we exit immediately and the GUI
  // keeps running. This matches the behavior users expect from a desktop
  // app launcher (no terminal session held open).
}

/**
 * `paat dashboard-snapshot --json` — print the full DashboardSnapshot the
 * React UI consumes via Tauri IPC. This is the shape the old Express
 * `/api/snapshot` endpoint returned: summary counters, liveSessions array
 * (with agent inference + Chrome metadata), conflicts, registryHealth, etc.
 *
 * Why a separate command from `paat status`:
 *   `paat status --json` returns the raw lane registry + port scan results.
 *   It's a different, simpler shape designed for terminal use. The dashboard
 *   needs the richer `buildSnapshot()` output (~10x the data) but humans
 *   reading `paat status` don't.
 *
 * Used by:
 *   gui/src-tauri/src/commands/snapshot.rs (shell-out target for the
 *   `get_snapshot` Tauri command the React UI invokes every 2 seconds).
 */
async function cmdDashboardSnapshot(ctx: CliContext): Promise<void> {
  const { buildSnapshot } = await import("../dashboard/snapshot.js");
  const snap = await buildSnapshot();
  // Always JSON — this command exists for machine consumers (the Tauri shell)
  // and there's no reasonable human-readable fallback for ~3KB of nested data.
  ctx.stdout.write(JSON.stringify(snap) + "\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

async function cmdProfiles(ctx: CliContext): Promise<void> {
  const sub = ctx.args.positional[0] ?? "list";
  if (sub === "list") return cmdProfilesList(ctx);
  if (sub === "prune") return cmdProfilesPrune(ctx);
  if (sub === "forget") return cmdProfilesForget(ctx);
  fail(ctx, `unknown 'profiles' subcommand: ${sub}. Try: list, prune, forget`, 1);
}

/**
 * `paat profiles forget --profile-dir <path> [--lane <id>]` — erase one lane's
 * saved browser data: delete the profile directory (guarded to the profiles
 * root) and drop the lane from the registry. Chrome must already be closed —
 * this is what the dashboard's Erase button calls after killing the pid.
 */
async function cmdProfilesForget(ctx: CliContext): Promise<void> {
  const profileDir = flagString(ctx.args, "profile-dir");
  if (!profileDir) fail(ctx, "missing required --profile-dir", 1);
  const laneId = flagString(ctx.args, "lane");
  try {
    const r = await forgetProfile({ profileDir: profileDir!, ...(laneId ? { laneId } : {}) });
    if (ctx.json) {
      emit(ctx, { ok: true, ...r });
    } else {
      ctx.stdout.write(
        `Erased saved data: ${profileDir}` + (r.removedLane ? ` (and removed lane ${laneId}).\n` : ".\n"),
      );
    }
  } catch (err) {
    fail(ctx, `could not erase profile (is Chrome still open?): ${(err as Error).message}`, 1);
  }
}

async function cmdProfilesList(ctx: CliContext): Promise<void> {
  const profiles = await listProfiles();
  const total = profiles.reduce((s, p) => s + p.sizeBytes, 0);
  const reclaimable = profiles.filter((p) => p.status === "orphaned" || p.status === "released");
  const reclaimBytes = reclaimable.reduce((s, p) => s + p.sizeBytes, 0);
  if (ctx.json) {
    emit(ctx, {
      ok: true,
      profilesDir: profilesDir(),
      count: profiles.length,
      totalBytes: total,
      reclaimableBytes: reclaimBytes,
      profiles,
    });
    return;
  }
  ctx.stdout.write(`Profiles dir: ${profilesDir()}\n`);
  ctx.stdout.write(`${profiles.length} profiles, ${formatBytes(total)} total\n\n`);
  if (profiles.length === 0) {
    ctx.stdout.write("No profiles.\n");
    return;
  }
  ctx.stdout.write(`  ${"SIZE".padStart(9)}  ${"STATUS".padEnd(9)}  ${"LAST SEEN".padEnd(19)}  PROFILE\n`);
  for (const p of profiles) {
    const last = p.lastSeen ? p.lastSeen.replace("T", " ").slice(0, 19) : "-";
    ctx.stdout.write(`  ${formatBytes(p.sizeBytes).padStart(9)}  ${p.status.padEnd(9)}  ${last.padEnd(19)}  ${p.name}\n`);
  }
  ctx.stdout.write(`\nReclaimable now (orphaned + released): ${formatBytes(reclaimBytes)} across ${reclaimable.length} profile(s).\n`);
  ctx.stdout.write(`Preview a cleanup with:  portpilot profiles prune        (add --yes to delete)\n`);
}

async function cmdProfilesPrune(ctx: CliContext): Promise<void> {
  const apply = flagBool(ctx.args, "yes");
  const fOrphaned = flagBool(ctx.args, "orphaned");
  const fReleased = flagBool(ctx.args, "released");
  const fStale = flagBool(ctx.args, "stale");
  const fAll = flagBool(ctx.args, "all");
  const anyStatusFlag = fOrphaned || fReleased || fStale || fAll;
  const olderRaw = flagString(ctx.args, "older-than");
  let olderThanMs: number | undefined;
  if (olderRaw) {
    olderThanMs = parseDurationMs(olderRaw);
    if (olderThanMs === undefined) fail(ctx, `invalid --older-than "${olderRaw}". Use e.g. 7d, 24h, 30m`, 1);
  }
  const nameFlag = flagString(ctx.args, "name");
  const names = [...ctx.args.positional.slice(1), ...(nameFlag ? [nameFlag] : [])];
  const hasNames = names.length > 0;
  // Conservative default (no status flags, no name filter): orphaned + released.
  const opts: ProfilePruneOptions = {
    includeOrphaned: fAll || fOrphaned || (!anyStatusFlag && !hasNames),
    includeReleased: fAll || fReleased || (!anyStatusFlag && !hasNames),
    includeStale: fAll || fStale,
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
    ...(hasNames ? { names } : {}),
  };

  const profiles = await listProfiles();
  const candidates = selectPruneCandidates(profiles, opts);
  const bytes = candidates.reduce((s, p) => s + p.sizeBytes, 0);

  if (!apply) {
    if (ctx.json) {
      emit(ctx, { ok: true, dryRun: true, wouldRemove: candidates, wouldReclaimBytes: bytes });
      return;
    }
    if (candidates.length === 0) {
      ctx.stdout.write("Nothing to prune with these filters.\n");
      return;
    }
    ctx.stdout.write(
      `Would remove ${candidates.length} profile(s), reclaiming ${formatBytes(bytes)} (preview — add --yes to delete):\n\n`,
    );
    for (const p of candidates) {
      ctx.stdout.write(`  ${formatBytes(p.sizeBytes).padStart(9)}  ${p.status.padEnd(9)}  ${p.name}\n`);
    }
    ctx.stdout.write(
      `\nActive/reserved profiles are never removed. Deleting a profile gives up its saved logins.\n` +
        `Re-run with --yes to actually delete.\n`,
    );
    return;
  }

  const removed: { name: string; sizeBytes: number }[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const p of candidates) {
    try {
      await deleteProfileDir(p.path);
      removed.push({ name: p.name, sizeBytes: p.sizeBytes });
    } catch (err) {
      failed.push({ name: p.name, error: (err as Error).message });
    }
  }
  const reclaimed = removed.reduce((s, p) => s + p.sizeBytes, 0);
  if (ctx.json) {
    emit(ctx, { ok: failed.length === 0, removed, failed, reclaimedBytes: reclaimed });
    if (failed.length) process.exit(1);
    return;
  }
  ctx.stdout.write(`Removed ${removed.length} profile(s), reclaimed ${formatBytes(reclaimed)}.\n`);
  if (failed.length) {
    ctx.stdout.write(`\n${failed.length} could not be removed (likely a Chrome still using it):\n`);
    for (const f of failed) ctx.stdout.write(`  ${f.name}: ${f.error}\n`);
    process.exit(1);
  }
}

async function cmdMcp(ctx: CliContext): Promise<void> {
  // Lazy import to avoid pulling MCP into every CLI invocation. If this install
  // lost its node_modules, the SDK import throws ERR_MODULE_NOT_FOUND at module
  // load and the process would die with no explanation (the agent just sees
  // "MCP server disconnected"). Catch that one case and print the exact fix.
  let mod: typeof import("../mcp/server.js");
  try {
    mod = await import("../mcp/server.js");
  } catch (err) {
    if (isMissingDependencyError(err)) {
      const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
      const missing = missingDependencyName(err);
      ctx.stderr.write(
        formatMissingDependencyMessage({ packageDir, ...(missing ? { missing } : {}) }),
      );
      process.exit(78); // EX_CONFIG: the install is incomplete, not a runtime bug
    }
    throw err;
  }
  await mod.runMcpStdio();
}

async function cmdInstallMcp(ctx: CliContext): Promise<void> {
  // Argument shape: paat install-mcp <claude|claude-code|codex|all|--all>
  // Default (no positional) is "all" so the simplest invocation Just Works.
  const VALID: McpClient[] = ["claude", "claude-code", "codex"];
  const target = ctx.args.positional[0];
  const allFlag = flagBool(ctx.args, "all");

  let clients: McpClient[];
  if (!target || target === "all" || allFlag) {
    clients = VALID;
  } else if ((VALID as string[]).includes(target)) {
    clients = [target as McpClient];
  } else {
    fail(
      ctx,
      `unknown MCP client '${target}'. Try: paat install-mcp <claude|claude-code|codex|all>`,
    );
  }

  interface ResultEntry {
    client: McpClient;
    ok: boolean;
    configPath?: string;
    backupPath?: string | null;
    action?: "installed" | "updated" | "already-installed" | "skipped";
    reason?: string;
    error?: string;
  }
  const results: ResultEntry[] = [];

  for (const c of clients!) {
    try {
      const r = await installMcpFor(c);
      results.push({
        ok: true,
        client: r.client,
        configPath: r.configPath,
        backupPath: r.backupPath,
        action: r.action,
        ...(r.reason ? { reason: r.reason } : {}),
      });
    } catch (err) {
      results.push({ ok: false, client: c, error: (err as Error).message });
    }
  }

  const wroteAnything = results.some(
    (r) => r.ok && (r.action === "installed" || r.action === "updated"),
  );
  // "skipped" results are not failures — they just mean the target client
  // isn't installed on this machine. Only true errors (thrown) count as !ok.
  const allOk = results.every((r) => r.ok);

  if (ctx.json) {
    emit(ctx, { ok: allOk, results });
    if (!allOk) process.exit(1);
    return;
  }

  for (const r of results) {
    if (!r.ok) {
      ctx.stderr.write(`x ${r.client}: ${r.error}\n`);
      continue;
    }
    if (r.action === "skipped") {
      ctx.stdout.write(`- ${r.client}: skipped\n`);
      if (r.reason) ctx.stdout.write(`  reason: ${r.reason}\n`);
      continue;
    }
    const actionMsg =
      r.action === "installed"
        ? "installed"
        : r.action === "updated"
          ? "updated (replaced different command/args)"
          : "already present (no change)";
    ctx.stdout.write(`+ ${r.client}: ${actionMsg}\n`);
    ctx.stdout.write(`  config: ${r.configPath}\n`);
    if (r.backupPath) ctx.stdout.write(`  backup: ${r.backupPath}\n`);
  }

  if (wroteAnything) {
    ctx.stdout.write(
      `\nRestart any open Claude Desktop / Codex Desktop windows to activate the MCP integration.\n`,
    );
  }
  if (!allOk) process.exit(1);
}

async function cmdAutostart(ctx: CliContext): Promise<void> {
  const sub = ctx.args.positional[0] ?? "status";
  const autostart = await import("./autostart.js");
  if (sub === "install") {
    try {
      const paths = await autostart.installAutostart();
      if (ctx.json) emit(ctx, { ok: true, ...paths });
      else {
        ctx.stdout.write(`✓ portpilot will now start automatically when you log in.\n\n`);
        ctx.stdout.write(`  shortcut: ${paths.shortcut}\n`);
        ctx.stdout.write(`  launcher: ${paths.launcher}\n\n`);
        ctx.stdout.write(`Disable any time with:  paat autostart uninstall\n`);
      }
    } catch (err) {
      fail(ctx, (err as Error).message);
    }
    return;
  }
  if (sub === "uninstall") {
    const r = await autostart.uninstallAutostart();
    if (ctx.json) emit(ctx, { ok: true, ...r });
    else if (r.removed) ctx.stdout.write(`✓ Removed autostart entry at ${r.path}\n`);
    else ctx.stdout.write(`No autostart entry was installed.\n`);
    return;
  }
  if (sub === "status") {
    const r = await autostart.autostartStatus();
    if (ctx.json) emit(ctx, { ok: true, ...r });
    else {
      ctx.stdout.write(`Autostart at Windows login: ${r.installed ? "ENABLED" : "disabled"}\n`);
      if (r.shortcut) ctx.stdout.write(`Shortcut path: ${r.shortcut}\n`);
    }
    return;
  }
  fail(ctx, `usage: portpilot autostart <install|uninstall|status>`);
}

async function dispatch(args: ParsedArgs): Promise<void> {
  const ctx: CliContext = {
    args,
    json: flagBool(args, "json"),
    stdout: process.stdout,
    stderr: process.stderr,
  };
  if (flagBool(args, "help") || flagBool(args, "h")) {
    process.stdout.write(HELP);
    return;
  }
  switch (args.command) {
    case "list":
      return cmdList(ctx);
    case "status":
      return cmdStatus(ctx);
    case "reserve":
      return cmdReserve(ctx);
    case "check":
      return cmdCheck(ctx);
    case "release":
      return cmdRelease(ctx);
    case "next":
      return cmdNext(ctx);
    case "doctor":
      return cmdDoctor(ctx);
    case "launch-chrome":
      return cmdLaunchChrome(ctx);
    case "config":
      return cmdConfig(ctx);
    case "dashboard":
      return cmdDashboard(ctx);
    case "dashboard-snapshot":
      return cmdDashboardSnapshot(ctx);
    case "shortcut":
      return cmdShortcut(ctx);
    case "install-mcp":
      return cmdInstallMcp(ctx);
    case "autostart":
      return cmdAutostart(ctx);
    case "prune":
      return cmdPrune(ctx);
    case "profiles":
      return cmdProfiles(ctx);
    case "mcp":
      return cmdMcp(ctx);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      return;
    default:
      fail(ctx, `unknown command: ${args.command}. Try 'portpilot help'.`);
  }
}

const args = parseArgs(process.argv.slice(2));
dispatch(args).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  } else {
    process.stderr.write(`portpilot: ${msg}\n`);
  }
  process.exit(1);
});

// Used by tests
export { dispatch, parseArgs };

export type { Lane };
