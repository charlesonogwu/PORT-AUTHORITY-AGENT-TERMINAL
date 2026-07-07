import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allocateLane, checkLane, findFreePort } from "../core/allocator.js";
import { findLane, listLanes, markStaleLanes, removeLane, setLaneStatus, touchLane, updateRegistry } from "../core/registry.js";
import { hasSonar, scanPorts } from "../core/scanner.js";
import { evaluateChromeAttach, launchChromeForLane, resolveChromeMode } from "../core/chrome.js";
import { assertModeSupported, launchBrowserForLane, normalizeBrowserKind } from "../core/browsers.js";
import { loadConfig } from "../core/config.js";
import { portpilotHome, profilesDir } from "../core/paths.js";
import { BrowserKind, isStale, laneBrowser, normalizeCwd, nowIso } from "../core/lane.js";

/**
 * Build the MCP server, registering one tool per CLI verb. The MCP server
 * shares the same core library as the CLI, so behaviour stays consistent.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "portpilot", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: "Coordinate dev server ports, Chrome debug ports, and Chrome profiles between local AI coding agents." },
  );

  const portRangeShape = {
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  };

  // ── HIGH-LEVEL "do everything" tool ──────────────────────────────────────
  server.registerTool(
    "open",
    {
      title: "Open Chrome via portpilot in one call (chrome.ts entrypoint)",
      description:
        "Canonical entrypoint for chrome.ts / Chrome remote-debugging workflows under portpilot. " +
        "All-in-one: reserves a lane (or reuses an existing one), launches Chrome bound to that lane's " +
        "debug port and dedicated user-data-dir, and navigates to the URL you supply. " +
        "USE THIS BEFORE OPENING A BROWSER OR CLAIMING BROWSER RESEARCH — calling it makes your session " +
        "visible on the portpilot dashboard at http://127.0.0.1:7321/, so the user can see the real " +
        "current page, agent owner, project folder, debug port, and pid in real time. " +
        "Idempotent: if a Chrome with the matching profile is already running on the lane's debug port, " +
        "this returns the existing session instead of launching a duplicate. " +
        "Prefer this single tool over composing reserve_lane + launch_chrome_lane manually unless you " +
        "need granular control. " +
        "VISIBILITY: pass mode='background' to launch a REAL (headed) Chrome that renders fully off-screen " +
        "and never steals focus — best for non-interactive CDP automation that only reads/clicks. " +
        "mode='headless' opens no window at all (lower footprint, but many sites like eBay block it). " +
        "mode='visible' (default) shows the window for manual steps (login, captcha). " +
        "BACKGROUND CONTRACT: when a lane is in background mode, your CDP client must NOT call " +
        "Page.bringToFront() and must NOT call Browser.setWindowBounds with on-screen coordinates — both " +
        "re-raise the window onto the user's desktop and defeat the off-screen placement.",
      inputSchema: {
        cwd: z.string().min(1).describe("Project working directory (absolute path)."),
        url: z
          .string()
          .optional()
          .describe(
            "URL to open as the first tab. Baked into Chrome's launch command, so no extra navigation step is needed. If omitted, Chrome opens to about:blank.",
          ),
        owner: z
          .string()
          .optional()
          .describe(
            'Pass ONLY the LLM provider name: "claude", "codex", "gemini", "cursor", "windsurf", "copilot", "chatgpt", "openhands", or "aider". DO NOT add prefixes, suffixes, batch numbers, or per-task identifiers — for example "codex-test-alpha", "agent-random-1", and "batch2-agent-3" are all WRONG. If you need to distinguish multiple parallel sessions of the same agent, put that distinction in the `sessionId` field, not here. Server normalizes anyway: any custom suffix is stripped from this field and auto-promoted to sessionId.',
          ),
        task: z.string().optional().describe("Short description of what you're doing."),
        sessionId: z.string().optional().describe("Optional parallel-session id when an agent runs multiple Chromes in the same project."),
        mode: z
          .enum(["visible", "background", "headless"])
          .optional()
          .describe(
            "Launch visibility. 'visible' (default) = normal window; 'background' = real headed Chrome rendered off-screen, never steals focus; 'headless' = no window (--headless=new). Overrides the PORTPILOT_CHROME_MODE env var and the config default. Omit to use the machine default. NOTE: 'background' is Chrome-only — Firefox rejects it (use 'visible' or 'headless').",
          ),
        browser: z
          .enum(["chrome", "firefox"])
          .optional()
          .describe(
            "Browser backend. 'chrome' (default) = Chromium via CDP. 'firefox' = a real Firefox with its own dedicated PortPilot profile, exposing WebDriver BiDi on the lane's debug port (ws://127.0.0.1:<port>/session) — NOT Chrome CDP; drive it with a BiDi client (Playwright firefox / WebDriver). PortPilot launches + coordinates Firefox but does not enumerate its tabs.",
          ),
        headless: z
          .boolean()
          .optional()
          .default(false)
          .describe("DEPRECATED — prefer mode='headless'. Kept for back-compat: when true and `mode` is unset, launches headless."),
      },
    },
    async (args) => {
      const owner = (args.owner ?? "agent").toString().trim() || "agent";
      const browser: BrowserKind = normalizeBrowserKind(args.browser) ?? "chrome";
      const reserve = await allocateLane({
        owner,
        cwd: args.cwd,
        sessionId: args.sessionId,
        task: args.task,
        browser,
      });
      const lane = reserve.lane;
      const label = browser === "firefox" ? "Firefox" : "Chrome";
      // Safety gate
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        return jsonResult({
          ok: false,
          error: `unsafe to launch ${label} on lane ${lane.id}: ${result.verdict.kind}`,
          verdict: result.verdict,
          lane,
        });
      }
      // Already running our browser with the matching profile?
      if (result.verdict.kind === "safe-attach") {
        return jsonResult({
          ok: true,
          alreadyRunning: true,
          browser,
          lane,
          dashboardUrl: "http://127.0.0.1:7321/",
          message: `${label} was already running with this lane's profile. Reusing it.`,
        });
      }
      // Resolve launch mode: explicit `mode` wins, else the legacy `headless`
      // boolean maps to "headless", else env var / config / "visible".
      const cfg = await loadConfig();
      const headlessFallback = args.headless ? "headless" : undefined;
      const mode = resolveChromeMode(args.mode ?? headlessFallback, cfg.chromeMode);
      // Refuse a mode the chosen backend can't honour honestly (e.g. Firefox +
      // background) rather than silently launching the wrong thing.
      try {
        assertModeSupported(browser, mode);
      } catch (err) {
        return jsonResult({ ok: false, error: (err as Error).message, lane });
      }
      const launch = await launchBrowserForLane(lane, {
        mode,
        ...(args.url ? { initialUrl: args.url } : {}),
      });
      await updateRegistry((lanes) =>
        lanes.map((l) => (l.id === lane.id ? { ...l, status: "active", lastSeen: nowIso(), pid: launch.pid ?? l.pid } : l)),
      );
      return jsonResult({
        ok: true,
        launched: true,
        browser,
        mode,
        lane: { ...lane, status: "active" },
        pid: launch.pid,
        dashboardUrl: "http://127.0.0.1:7321/",
        navigatedTo: args.url ?? null,
        ...(browser === "firefox"
          ? { note: "Firefox lane: debug port serves WebDriver BiDi (ws://127.0.0.1:" + lane.chromeDebugPort + "/session), not Chrome CDP." }
          : {}),
      });
    },
  );

  server.registerTool(
    "reserve_lane",
    {
      title: "Reserve a portpilot chrome.ts lane",
      description:
        "Reserve a coordination lane for an agent working in a project directory. Allocates a dedicated app port, " +
        "Chrome debug port, and Chrome user-data-dir for chrome.ts / CDP automation. The lane shows up on the " +
        "portpilot dashboard at http://127.0.0.1:7321/ so the user can track which agent is working in which folder. " +
        "Idempotent: returns the existing lane if one is already active for this (owner, cwd, sessionId). " +
        "Most callers should use the higher-level 'open' tool instead, which reserves AND launches Chrome AND " +
        "navigates in a single call.",
      inputSchema: {
        owner: z
          .string()
          .min(1)
          .describe(
            'Pass ONLY the LLM provider name: "claude", "codex", "gemini", "cursor", "windsurf", "copilot", "chatgpt", "openhands", or "aider". Never add suffixes, batch numbers, or arbitrary identifiers (e.g. "codex-test-alpha", "agent-random-1", "batch2-agent-3" are all WRONG). Use `sessionId` for per-task distinctions. Server canonicalizes this field — anything beyond the LLM name is auto-promoted to sessionId.',
          ),
        cwd: z.string().min(1).describe("Project working directory absolute path."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Optional parallel session id. Different sessions for the same (owner, cwd) get different ports and profile dirs, so one agent can run multiple concurrent Chrome instances. Omit for the implicit 'default' session.",
          ),
        task: z.string().optional().describe("Short description of the task this lane is for."),
        appPortRange: z.object(portRangeShape).optional(),
        chromeDebugRange: z.object(portRangeShape).optional(),
        withAppPort: z.boolean().optional().default(true),
        withChromePort: z.boolean().optional().default(true),
        browser: z
          .enum(["chrome", "firefox"])
          .optional()
          .describe("Browser backend for this lane. 'chrome' (default) or 'firefox' (own dedicated profile; debug port serves WebDriver BiDi, not CDP). Chrome and Firefox lanes for the same (owner, cwd, sessionId) are distinct and get separate profile dirs."),
        browserScript: z.string().optional(),
      },
    },
    async (args) => {
      const result = await allocateLane({
        owner: args.owner,
        cwd: args.cwd,
        sessionId: args.sessionId,
        task: args.task,
        appPortRange: args.appPortRange,
        chromeDebugRange: args.chromeDebugRange,
        withAppPort: args.withAppPort,
        withChromePort: args.withChromePort,
        ...(normalizeBrowserKind(args.browser) ? { browser: normalizeBrowserKind(args.browser)! } : {}),
        browserScript: args.browserScript,
      });
      return jsonResult({ ok: true, alreadyExisted: result.alreadyExisted, scanSource: result.scanSource, lane: result.lane });
    },
  );

  server.registerTool(
    "list_lanes",
    {
      title: "List lanes",
      description: "List every lane currently in the registry, including released ones.",
      inputSchema: {
        owner: z.string().optional(),
      },
    },
    async (args) => {
      const lanes = await listLanes();
      const filtered = args.owner ? lanes.filter((l) => l.owner === args.owner) : lanes;
      return jsonResult({ ok: true, lanes: filtered });
    },
  );

  server.registerTool(
    "check_lane",
    {
      title: "Check lane",
      description:
        "Check whether the named lane is safe to use right now. Returns a verdict that distinguishes free ports, attachable Chrome instances with the matching profile, and unsafe situations where a foreign process holds the port.",
      inputSchema: {
        owner: z.string().min(1),
        cwd: z.string().min(1),
        sessionId: z.string().optional(),
      },
    },
    async (args) => {
      const lane = await findLane({ owner: args.owner, cwd: args.cwd, ...(args.sessionId ? { sessionId: args.sessionId } : {}) });
      if (!lane) {
        return jsonResult({
          ok: false,
          error: `no lane found for owner=${args.owner} cwd=${args.cwd}${args.sessionId ? ` sessionId=${args.sessionId}` : ""}. Call reserve_lane first.`,
        });
      }
      await touchLane(lane.id);
      const result = await checkLane(lane);
      const verdict = result.verdict;
      const safe = verdict.kind === "safe-free" || verdict.kind === "safe-attach";
      if (safe && lane.status === "reserved") await setLaneStatus(lane.id, "active");
      return jsonResult({ ok: safe, verdict, lane, appPortInUse: result.appPortInUse, scanSource: result.scanSource, scanErrors: result.scanErrors });
    },
  );

  server.registerTool(
    "release_lane",
    {
      title: "Release lane",
      description: "Mark a lane as released. Does not kill processes. Set remove=true to delete the entry entirely.",
      inputSchema: {
        owner: z.string().min(1),
        cwd: z.string().min(1),
        sessionId: z.string().optional(),
        remove: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      const lane = await findLane({ owner: args.owner, cwd: args.cwd, ...(args.sessionId ? { sessionId: args.sessionId } : {}), includeReleased: true });
      if (!lane) {
        return jsonResult({ ok: false, error: `no lane found for owner=${args.owner} cwd=${args.cwd}` });
      }
      if (args.remove) {
        await removeLane(lane.id);
        return jsonResult({ ok: true, removed: true, laneId: lane.id });
      }
      const updated = await setLaneStatus(lane.id, "released");
      return jsonResult({ ok: true, released: true, lane: updated });
    },
  );

  server.registerTool(
    "find_free_lane",
    {
      title: "Find free port",
      description: "Find the next free port in a range, considering both live port observations and active reservations.",
      inputSchema: {
        range: z.object(portRangeShape).optional(),
      },
    },
    async (args) => {
      const port = await findFreePort({ range: args.range });
      return jsonResult({ ok: port !== undefined, port });
    },
  );

  server.registerTool(
    "launch_chrome_lane",
    {
      title: "Launch Chrome for an existing portpilot chrome.ts lane",
      description:
        "Launch Chrome for an already-reserved portpilot lane, binding to that lane's debug port and dedicated " +
        "user-data-dir. The launched session appears on the portpilot dashboard at http://127.0.0.1:7321/ as a " +
        "live entry. Refuses to launch when the port is held by a foreign Chrome instance (different profile) or " +
        "a non-Chrome process — prevents one agent from accidentally driving another agent's browser. " +
        "Set dryRun=true to return the launch command without executing. Most callers should use the 'open' tool " +
        "instead, which combines reserve_lane + launch_chrome_lane in one call. " +
        "VISIBILITY: mode='background' launches a real headed Chrome off-screen that never steals focus (best for " +
        "non-interactive CDP automation); mode='headless' opens no window (blocked by some sites); mode='visible' " +
        "(default) is a normal window. In background mode, the CDP client must not call Page.bringToFront() or " +
        "Browser.setWindowBounds with on-screen coordinates.",
      inputSchema: {
        owner: z.string().min(1),
        cwd: z.string().min(1),
        sessionId: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        binaryPath: z.string().optional(),
        mode: z
          .enum(["visible", "background", "headless"])
          .optional()
          .describe(
            "Launch visibility. 'visible' (default) = normal window; 'background' = real headed Chrome off-screen, no focus steal; 'headless' = no window. Overrides PORTPILOT_CHROME_MODE and the config default. Omit to use the machine default.",
          ),
      },
    },
    async (args) => {
      const lane = await findLane({ owner: args.owner, cwd: args.cwd, ...(args.sessionId ? { sessionId: args.sessionId } : {}) });
      if (!lane) return jsonResult({ ok: false, error: `no lane found for owner=${args.owner} cwd=${args.cwd}${args.sessionId ? ` sessionId=${args.sessionId}` : ""}` });
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        return jsonResult({ ok: false, error: `unsafe to launch Chrome: ${result.verdict.kind}`, verdict: result.verdict });
      }
      if (result.verdict.kind === "safe-attach") {
        return jsonResult({ ok: true, attached: true, lane, message: "Chrome already running with the matching profile; attach instead of launching." });
      }
      const cfg = await loadConfig();
      const mode = resolveChromeMode(args.mode, cfg.chromeMode);
      const launch = await launchChromeForLane(lane, { dryRun: args.dryRun, binaryPath: args.binaryPath, mode });
      await updateRegistry((lanes) =>
        lanes.map((l) => (l.id === lane.id ? { ...l, status: "active", lastSeen: nowIso(), pid: launch.pid ?? l.pid } : l)),
      );
      return jsonResult({ ok: true, launched: !args.dryRun, mode, lane, command: { binary: launch.binary, args: launch.args }, pid: launch.pid });
    },
  );

  server.registerTool(
    "launch_browser_lane",
    {
      title: "Launch a browser (chrome or firefox) for an existing portpilot lane",
      description:
        "Generic launcher for an already-reserved lane — routes to Chrome or Firefox by the lane's browser. " +
        "Binds the browser to that lane's debug port + dedicated profile and shows it on the dashboard. Refuses " +
        "to launch when the port is held by a foreign browser (different profile) or a non-browser process. " +
        "For FIREFOX lanes the debug port serves WebDriver BiDi (ws://127.0.0.1:<port>/session), not Chrome CDP, " +
        "and mode='background' is rejected (Firefox has no off-screen window mode — use visible/headless). " +
        "Most callers should use the higher-level 'open' tool with a browser argument instead. Set dryRun=true to " +
        "return the launch command without executing.",
      inputSchema: {
        owner: z.string().min(1),
        cwd: z.string().min(1),
        sessionId: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        binaryPath: z.string().optional(),
        mode: z
          .enum(["visible", "background", "headless"])
          .optional()
          .describe("Launch mode. 'visible' (default), 'headless', or 'background' (Chrome-only; Firefox rejects it)."),
      },
    },
    async (args) => {
      const lane = await findLane({ owner: args.owner, cwd: args.cwd, ...(args.sessionId ? { sessionId: args.sessionId } : {}) });
      if (!lane) return jsonResult({ ok: false, error: `no lane found for owner=${args.owner} cwd=${args.cwd}${args.sessionId ? ` sessionId=${args.sessionId}` : ""}` });
      const browser = laneBrowser(lane);
      const label = browser === "firefox" ? "Firefox" : "Chrome";
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        return jsonResult({ ok: false, error: `unsafe to launch ${label}: ${result.verdict.kind}`, verdict: result.verdict });
      }
      if (result.verdict.kind === "safe-attach") {
        return jsonResult({ ok: true, attached: true, browser, lane, message: `${label} already running with the matching profile; attach instead of launching.` });
      }
      const cfg = await loadConfig();
      const mode = resolveChromeMode(args.mode, cfg.chromeMode);
      try {
        assertModeSupported(browser, mode);
      } catch (err) {
        return jsonResult({ ok: false, error: (err as Error).message, lane });
      }
      const launch = await launchBrowserForLane(lane, { dryRun: args.dryRun, binaryPath: args.binaryPath, mode });
      await updateRegistry((lanes) =>
        lanes.map((l) => (l.id === lane.id ? { ...l, status: "active", lastSeen: nowIso(), pid: launch.pid ?? l.pid } : l)),
      );
      return jsonResult({
        ok: true,
        launched: !args.dryRun,
        browser,
        mode,
        lane,
        command: { binary: launch.binary, args: launch.args },
        pid: launch.pid,
        ...(browser === "firefox"
          ? { note: "Firefox lane: debug port serves WebDriver BiDi (ws://127.0.0.1:" + lane.chromeDebugPort + "/session), not Chrome CDP." }
          : {}),
      });
    },
  );

  server.registerTool(
    "scan_ports",
    {
      title: "Scan listening ports",
      description:
        "Return every TCP port currently listening on the local machine, with the process name and command line where available. This is the raw scanner view — used internally by check_lane and doctor — exposed for agents that want to inspect the live port table directly. Use the optional `port` filter to restrict to a single port, or `portRange` for a range.",
      inputSchema: {
        port: z.number().int().positive().optional().describe("Filter to a single port number."),
        portRange: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).optional().describe("Filter to a port range (inclusive)."),
        chromeOnly: z.boolean().optional().default(false).describe("Only return Chromium-family processes."),
      },
    },
    async (args) => {
      const scan = await scanPorts();
      let observations = scan.observations;
      if (typeof args.port === "number") {
        observations = observations.filter((o) => o.port === args.port);
      }
      if (args.portRange) {
        observations = observations.filter((o) => o.port >= args.portRange!.start && o.port <= args.portRange!.end);
      }
      if (args.chromeOnly) {
        const isChrome = (cmd: string | undefined): boolean => {
          const c = (cmd ?? "").toLowerCase();
          return c.includes("chrome") || c.includes("chromium") || c.includes("brave") || c.includes("msedge");
        };
        observations = observations.filter((o) => isChrome(o.command));
      }
      const lanes = await listLanes();
      // Annotate each observation with which lane (if any) is reserving that port.
      const annotated = observations.map((o) => {
        const lane = lanes.find(
          (l) => l.status !== "released" && (l.appPort === o.port || l.chromeDebugPort === o.port),
        );
        const role = lane
          ? lane.chromeDebugPort === o.port
            ? "chrome-debug"
            : "app"
          : null;
        return {
          ...o,
          reservedBy: lane ? { laneId: lane.id, owner: lane.owner, project: lane.project, role } : null,
        };
      });
      return jsonResult({
        ok: true,
        scanSource: scan.source,
        scanErrors: scan.errors,
        count: annotated.length,
        observations: annotated,
      });
    },
  );

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description:
        "Audit the registry against live port observations. Reports stale lanes, foreign Chrome instances on reserved ports, duplicate reservations, and missing scanner backends. Never kills processes.",
      inputSchema: {},
    },
    async () => {
      await markStaleLanes();
      const lanes = await listLanes();
      const scan = await scanPorts();
      const sonar = await hasSonar().catch(() => false);
      const issues: { laneId?: string; severity: "info" | "warn" | "error"; message: string; suggestion?: string }[] = [];
      if (!sonar) issues.push({ severity: "info", message: "Sonar not installed; using native scan." });
      if (scan.source === "empty") issues.push({ severity: "error", message: "No scanner backend available." });
      for (const lane of lanes) {
        if (lane.status === "released") continue;
        const verdict = evaluateChromeAttach(lane, scan.observations);
        if (verdict.kind === "unsafe-foreign-chrome") {
          issues.push({
            laneId: lane.id,
            severity: "error",
            message: `Chrome debug port ${lane.chromeDebugPort} is held by Chrome with profile "${verdict.foundProfile ?? "unknown"}"`,
            suggestion: `Close the foreign Chrome instance or release ${lane.id}.`,
          });
        }
        if (verdict.kind === "unsafe-unknown") {
          issues.push({
            laneId: lane.id,
            severity: "error",
            message: `Chrome debug port ${lane.chromeDebugPort} is held by ${verdict.observation.command ?? "an unknown process"} (pid=${verdict.observation.pid ?? "?"}).`,
            suggestion: `Release and re-reserve ${lane.id}.`,
          });
        }
        if (isStale(lane)) {
          issues.push({ laneId: lane.id, severity: "warn", message: `Lane ${lane.id} is stale (lastSeen=${lane.lastSeen}).` });
        }
      }
      // Detect duplicate Chrome ports
      const seen = new Map<number, string[]>();
      for (const lane of lanes) {
        if (lane.status === "released") continue;
        if (typeof lane.chromeDebugPort !== "number") continue;
        const ids = seen.get(lane.chromeDebugPort) ?? [];
        ids.push(lane.id);
        seen.set(lane.chromeDebugPort, ids);
      }
      for (const [port, ids] of seen) {
        if (ids.length > 1) {
          issues.push({ severity: "error", message: `Duplicate Chrome port ${port}: ${ids.join(", ")}` });
        }
      }
      return jsonResult({
        ok: issues.every((i) => i.severity !== "error"),
        home: portpilotHome(),
        profilesDir: profilesDir(),
        sonarAvailable: sonar,
        scanSource: scan.source,
        lanes,
        issues,
      });
    },
  );

  return server;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Run the portpilot MCP server over stdio. This is the entrypoint used by
 * `portpilot mcp`.
 */
export async function runMcpStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void normalizeCwd; // keep import for downstream consumers
