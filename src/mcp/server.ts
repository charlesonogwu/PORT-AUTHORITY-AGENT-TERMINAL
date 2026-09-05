import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { adoptProfileLane, allocateLane, checkLane, findFreePort } from "../core/allocator.js";
import { AmbiguousLaneError, filterLanes, listLanes, markStaleLanes, rememberLaneProfile, removeLane, resolveLaneSelector, setLaneStatus, touchLane, updateRegistry } from "../core/registry.js";
import { hasSonar, scanPorts } from "../core/scanner.js";
import { evaluateChromeAttach, launchChromeForLane, resolveChromeMode } from "../core/chrome.js";
import { assertModeSupported, browserLabel, launchBrowserForLane, normalizeBrowserKind } from "../core/browsers.js";
import { loadConfig } from "../core/config.js";
import { portpilotHome, profilesDir } from "../core/paths.js";
import { BrowserKind, Lane, isStale, laneBrowser, normalizeCwd, nowIso } from "../core/lane.js";
import { PageControlError, PageController, openPageController } from "../core/pagecontrol.js";
import { createSupervisorClient } from "../supervisor/client.js";
import { launchPersistentBrowser } from "../supervisor/routing.js";

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

  const exactLaneId = z.string().min(1).optional().describe("Immutable PortPilot lane ID (PPID). When supplied, owner/cwd/sessionId are not needed and PortPilot never guesses another profile.");
  const optionalOwner = z.string().min(1).optional();
  const optionalCwd = z.string().min(1).optional();

  async function resolveToolLane(
    args: { laneId?: string; owner?: string; cwd?: string; sessionId?: string },
    includeReleased = false,
  ): Promise<{ lane?: Lane; error?: string }> {
    try {
      if (args.laneId) {
        const lane = await resolveLaneSelector({ laneId: args.laneId, includeReleased });
        return lane ? { lane } : { error: `no lane found for immutable PPID ${args.laneId}` };
      }
      if (!args.owner || !args.cwd) {
        return { error: "provide laneId, or both owner and cwd" };
      }
      const lane = await resolveLaneSelector({
        owner: args.owner,
        cwd: args.cwd,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        includeReleased,
      });
      return lane ? { lane } : { error: `no lane found for owner=${args.owner} cwd=${args.cwd}` };
    } catch (error) {
      if (error instanceof AmbiguousLaneError) return { error: error.message };
      throw error;
    }
  }

  // ── HIGH-LEVEL "do everything" tool ──────────────────────────────────────
  server.registerTool(
    "open",
    {
      title: "Open Chrome via portpilot in one call (chrome.ts entrypoint)",
      description:
        "Canonical entrypoint for chrome.ts / Chrome remote-debugging workflows under portpilot. " +
        "When the user refers to a previously saved account or purpose, call list_lanes with cwd and purpose first, then reopen the returned immutable PPID. " +
        "All-in-one: reserves a lane (or reuses an existing one), launches Chrome bound to that lane's " +
        "debug port and dedicated user-data-dir, and navigates to the URL you supply. " +
        "USE THIS BEFORE OPENING A BROWSER OR CLAIMING BROWSER RESEARCH — calling it makes your session " +
        "visible on the PortPilot dashboard (a native desktop app the user opens themselves), so the user can see the real " +
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
        laneId: exactLaneId,
        cwd: optionalCwd.describe("Project working directory (absolute path). Required unless laneId is supplied."),
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
            'Pass ONLY the LLM provider name: "claude", "codex", "gemini", "cursor", "windsurf", "copilot", "chatgpt", "openhands", "aider", "goose", or "opencode". DO NOT add prefixes, suffixes, batch numbers, or per-task identifiers — for example "codex-test-alpha", "agent-random-1", and "batch2-agent-3" are all WRONG. If you need to distinguish multiple parallel sessions of the same agent, put that distinction in the `sessionId` field, not here. Server normalizes anyway: any custom suffix is stripped from this field and auto-promoted to sessionId.',
          ),
        task: z.string().optional().describe("Short description of what you're doing."),
        sessionId: z.string().optional().describe("Optional parallel-session id — ONLY when you truly need a second independent browser in the same project (e.g. two different logins). Every extra sessionId launches a WHOLE separate browser (~0.5-1.5 GB RAM). If you just need more pages, reuse your existing lane and open tabs with page_newtab instead (~100-200 MB per tab)."),
        mode: z
          .enum(["visible", "background", "headless"])
          .optional()
          .describe(
            "Launch visibility. 'visible' (default) = normal window; 'background' = real headed browser rendered off-screen, never steals focus; 'headless' = no window (--headless=new). Overrides the PORTPILOT_CHROME_MODE env var and the config default. Omit to use the machine default. NOTE: 'background' works for chrome and edge (both Chromium) — Firefox rejects it (use 'visible' or 'headless').",
          ),
        browser: z
          .enum(["chrome", "firefox", "edge"])
          .optional()
          .describe(
            "Browser backend. OMIT unless the user asked for a specific browser: when omitted, an existing lane for this (owner, cwd, session) keeps its browser, and new lanes use the user's configured default browser (dashboard 'Default browser' picker; falls back to chrome). 'chrome' = Chromium via CDP. 'edge' = Microsoft Edge — also Chromium, real CDP, all modes. 'firefox' = a real Firefox exposing WebDriver BiDi on the lane's debug port — NOT Chrome CDP; drive it with the page_* tools. Every backend gets its own dedicated PortPilot profile — never the user's personal browser profile.",
          ),
        headless: z
          .boolean()
          .optional()
          .default(false)
          .describe("DEPRECATED — prefer mode='headless'. Kept for back-compat: when true and `mode` is unset, launches headless."),
      },
    },
    async (args) => {
      const exact = args.laneId ? await resolveToolLane({ laneId: args.laneId }, true) : undefined;
      if (exact?.error || (args.laneId && !exact?.lane)) return jsonResult({ ok: false, error: exact?.error });
      if (!args.laneId && !args.cwd) return jsonResult({ ok: false, error: "cwd is required unless laneId is supplied" });
      const owner = exact?.lane?.owner ?? ((args.owner ?? "agent").toString().trim() || "agent");
      const cwd = exact?.lane?.cwd ?? args.cwd!;
      // Only pass browser through when the agent explicitly asked for one.
      // Omitted → the allocator resolves it: an existing lane keeps its
      // browser, else the user's configured defaultBrowser, else chrome.
      const requestedBrowser = normalizeBrowserKind(args.browser);
      const reserve = await allocateLane({
        owner,
        cwd,
        ...(args.laneId ? { laneId: args.laneId } : {}),
        sessionId: args.sessionId,
        task: args.task,
        ...(requestedBrowser ? { browser: requestedBrowser } : {}),
      });
      const lane = reserve.lane;
      const browser: BrowserKind = laneBrowser(lane);
      const label = browserLabel(browser);
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
        const attached = await launchPersistentBrowser(lane, {});
        return jsonResult({
          ok: true,
          alreadyRunning: true,
          browser,
          lane: { ...lane, browserPid: attached.pid, browserState: "active" },
          dashboard: "PortPilot dashboard app (native; the user opens it from their desktop or with: paat dashboard)",
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
      const launch = await launchPersistentBrowser(lane, {
        mode,
        ...(args.url ? { initialUrl: args.url } : {}),
      });
      return jsonResult({
        ok: true,
        launched: true,
        browser,
        mode,
        lane: { ...lane, status: "active" },
        pid: launch.pid,
        dashboard: "PortPilot dashboard app (native; the user opens it from their desktop or with: paat dashboard)",
        navigatedTo: args.url ?? null,
        ...(browser === "firefox"
          ? { note: "Firefox lane: debug port serves WebDriver BiDi (ws://127.0.0.1:" + lane.chromeDebugPort + "/session), not Chrome CDP. Drive it with the page_* tools (page_goto/page_text/page_eval/page_click/page_fill/page_screenshot) — they speak BiDi for you." }
          : {}),
      });
    },
  );

  server.registerTool(
    "close_browser",
    {
      title: "Explicitly close one persistent lane browser",
      description:
        "Close exactly one PortPilot browser after re-verifying its browser type, debug port, pid, and dedicated profile. " +
        "MCP disconnects and release_lane never close browsers; use this only when the browser should actually exit.",
      inputSchema: {
        laneId: exactLaneId,
        owner: optionalOwner,
        cwd: optionalCwd,
        sessionId: z.string().optional(),
      },
    },
    async (args) => {
      const selected = await resolveToolLane(args);
      if (!selected.lane) return jsonResult({ ok: false, error: selected.error });
      const lane = selected.lane;
      try {
        const result = await createSupervisorClient().close({ laneId: lane.id });
        return jsonResult({ ok: true, ...result });
      } catch (error) {
        return jsonResult({ ok: false, error: `PortPilot supervisor close failed: ${(error as Error).message}` });
      }
    },
  );

  server.registerTool(
    "reserve_lane",
    {
      title: "Reserve a portpilot chrome.ts lane",
      description:
        "Reserve a coordination lane for an agent working in a project directory. Allocates a dedicated app port, " +
        "Chrome debug port, and Chrome user-data-dir for chrome.ts / CDP automation. The lane shows up on the " +
        "PortPilot dashboard (native desktop app) so the user can track which agent is working in which folder. " +
        "Idempotent: returns the existing lane if one is already active for this (owner, cwd, sessionId). " +
        "Most callers should use the higher-level 'open' tool instead, which reserves AND launches Chrome AND " +
        "navigates in a single call.",
      inputSchema: {
        owner: z
          .string()
          .min(1)
          .describe(
            'Pass ONLY the LLM provider name: "claude", "codex", "gemini", "cursor", "windsurf", "copilot", "chatgpt", "openhands", "aider", "goose", or "opencode". Never add suffixes, batch numbers, or arbitrary identifiers (e.g. "codex-test-alpha", "agent-random-1", "batch2-agent-3" are all WRONG). Use `sessionId` for per-task distinctions. Server canonicalizes this field — anything beyond the LLM name is auto-promoted to sessionId.',
          ),
        cwd: z.string().min(1).describe("Project working directory absolute path."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Optional parallel session id. Different sessions for the same (owner, cwd) get different ports and profile dirs, so one agent can run multiple concurrent browser instances. Omit for the implicit 'default' session. RAM note: each extra session is a whole separate browser (~0.5-1.5 GB); if you only need more pages, use page_newtab on your existing lane instead.",
          ),
        task: z.string().optional().describe("Short description of the task this lane is for."),
        appPortRange: z.object(portRangeShape).optional(),
        chromeDebugRange: z.object(portRangeShape).optional(),
        withAppPort: z.boolean().optional().default(true),
        withChromePort: z.boolean().optional().default(true),
        browser: z
          .enum(["chrome", "firefox", "edge"])
          .optional()
          .describe("Browser backend for this lane. OMIT unless the user asked for a specific browser — omitted means an existing lane keeps its browser and new lanes use the user's configured default (dashboard picker; falls back to chrome). 'chrome', 'edge' (Chromium, real CDP), or 'firefox' (WebDriver BiDi, not CDP). Explicit lanes for the same (owner, cwd, sessionId) but different browsers are distinct and get separate profile dirs."),
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
      description: "Find saved browser profiles by workspace and intended purpose before creating another lane. A single match includes an exact PPID reconnect command; multiple matches are returned without guessing. Purpose metadata describes intent and is not proof that a website is currently authenticated.",
      inputSchema: {
        owner: z.string().optional(),
        cwd: z.string().optional(),
        purpose: z.string().optional(),
      },
    },
    async (args) => {
      const lanes = filterLanes(await listLanes(), {
        ...(args.owner ? { owner: args.owner } : {}),
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.purpose ? { purpose: args.purpose } : {}),
        includeReleased: true,
      });
      const reconnect = lanes.length === 1 ? {
        laneId: lanes[0]!.id,
        command: `portpilot open --lane-id ${lanes[0]!.id}`,
      } : null;
      return jsonResult({ ok: true, lanes, reconnect });
    },
  );

  server.registerTool(
    "remember_profile",
    {
      title: "Label a saved PortPilot profile",
      description: "Attach a friendly label and normalized purpose tags to one exact PPID. This never changes the PPID or profile directory and never inspects or claims that a website is logged in.",
      inputSchema: {
        laneId: z.string().min(1),
        label: z.string().min(1).max(80).optional(),
        purposes: z.array(z.string().min(1)).max(12).optional(),
      },
    },
    async (args) => {
      if (!args.label && (!args.purposes || args.purposes.length === 0)) {
        return jsonResult({ ok: false, error: "provide label and/or at least one purpose" });
      }
      const lane = await rememberLaneProfile(args.laneId, { label: args.label, purposes: args.purposes });
      return lane ? jsonResult({ ok: true, lane }) : jsonResult({ ok: false, error: `no lane found for immutable PPID ${args.laneId}` });
    },
  );

  server.registerTool(
    "adopt_profile",
    {
      title: "Adopt an orphaned PortPilot browser profile",
      description:
        "Explicitly register an existing orphaned profile directory beneath PORTPILOT_HOME/profiles as one new immutable PPID. " +
        "Refuses normal/personal browser profiles and profiles already owned by another lane. Does not inspect cookies or launch a browser.",
      inputSchema: {
        owner: z.string().min(1),
        cwd: z.string().min(1),
        sessionId: z.string().optional(),
        task: z.string().optional(),
        profileDir: z.string().min(1),
        browser: z.enum(["chrome", "firefox", "edge"]).optional().default("chrome"),
      },
    },
    async (args) => {
      try {
        const result = await adoptProfileLane(args);
        return jsonResult({ ok: true, adopted: true, lane: result.lane });
      } catch (error) {
        return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  server.registerTool(
    "check_lane",
    {
      title: "Check lane",
      description:
        "Check whether the named lane is safe to use right now. Returns a verdict that distinguishes free ports, attachable Chrome instances with the matching profile, and unsafe situations where a foreign process holds the port.",
      inputSchema: {
        laneId: exactLaneId,
        owner: optionalOwner,
        cwd: optionalCwd,
        sessionId: z.string().optional(),
      },
    },
    async (args) => {
      const selected = await resolveToolLane(args);
      if (!selected.lane) return jsonResult({ ok: false, error: selected.error });
      const lane = selected.lane;
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
        laneId: exactLaneId,
        owner: optionalOwner,
        cwd: optionalCwd,
        sessionId: z.string().optional(),
        remove: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      const selected = await resolveToolLane(args, true);
      if (!selected.lane) return jsonResult({ ok: false, error: selected.error });
      const lane = selected.lane;
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
        "user-data-dir. The launched session appears on the PortPilot dashboard (native desktop app) as a " +
        "live entry. Refuses to launch when the port is held by a foreign Chrome instance (different profile) or " +
        "a non-Chrome process — prevents one agent from accidentally driving another agent's browser. " +
        "Set dryRun=true to return the launch command without executing. Most callers should use the 'open' tool " +
        "instead, which combines reserve_lane + launch_chrome_lane in one call. " +
        "VISIBILITY: mode='background' launches a real headed Chrome off-screen that never steals focus (best for " +
        "non-interactive CDP automation); mode='headless' opens no window (blocked by some sites); mode='visible' " +
        "(default) is a normal window. In background mode, the CDP client must not call Page.bringToFront() or " +
        "Browser.setWindowBounds with on-screen coordinates.",
      inputSchema: {
        laneId: exactLaneId,
        owner: optionalOwner,
        cwd: optionalCwd,
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
      const selected = await resolveToolLane(args);
      if (!selected.lane) return jsonResult({ ok: false, error: selected.error });
      const lane = selected.lane;
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        return jsonResult({ ok: false, error: `unsafe to launch Chrome: ${result.verdict.kind}`, verdict: result.verdict });
      }
      if (result.verdict.kind === "safe-attach") {
        const attached = await launchPersistentBrowser(lane, {});
        return jsonResult({ ok: true, attached: true, lane, pid: attached.pid, message: "Chrome already running with the matching profile; attach instead of launching." });
      }
      const cfg = await loadConfig();
      const mode = resolveChromeMode(args.mode, cfg.chromeMode);
      if (args.dryRun) {
        const plan = await launchChromeForLane(lane, { dryRun: true, binaryPath: args.binaryPath, mode });
        return jsonResult({
          ok: true,
          launched: false,
          mode,
          lane,
          command: { binary: plan.binary, args: plan.args },
        });
      }
      const launch = await launchPersistentBrowser(lane, { binaryPath: args.binaryPath, mode });
      return jsonResult({
        ok: true,
        launched: !args.dryRun,
        mode,
        lane,
        command: launch.command,
        pid: launch.pid,
      });
    },
  );

  server.registerTool(
    "launch_browser_lane",
    {
      title: "Launch a browser (chrome, edge, or firefox) for an existing portpilot lane",
      description:
        "Generic launcher for an already-reserved lane — routes to Chrome, Edge, or Firefox by the lane's browser. " +
        "Binds the browser to that lane's debug port + dedicated profile and shows it on the dashboard. Refuses " +
        "to launch when the port is held by a foreign browser (different profile) or a non-browser process. " +
        "EDGE lanes behave exactly like Chrome (Chromium, real CDP, all modes). " +
        "For FIREFOX lanes the debug port serves WebDriver BiDi (ws://127.0.0.1:<port>/session), not Chrome CDP, " +
        "and mode='background' is rejected (Firefox has no off-screen window mode — use visible/headless). " +
        "Most callers should use the higher-level 'open' tool with a browser argument instead. Set dryRun=true to " +
        "return the launch command without executing.",
      inputSchema: {
        laneId: exactLaneId,
        owner: optionalOwner,
        cwd: optionalCwd,
        sessionId: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        binaryPath: z.string().optional(),
        mode: z
          .enum(["visible", "background", "headless"])
          .optional()
          .describe("Launch mode. 'visible' (default), 'headless', or 'background' (chrome/edge only; Firefox rejects it)."),
      },
    },
    async (args) => {
      const selected = await resolveToolLane(args);
      if (!selected.lane) return jsonResult({ ok: false, error: selected.error });
      const lane = selected.lane;
      const browser = laneBrowser(lane);
      const label = browserLabel(browser);
      const result = await checkLane(lane);
      if (result.verdict.kind === "unsafe-foreign-chrome" || result.verdict.kind === "unsafe-unknown") {
        return jsonResult({ ok: false, error: `unsafe to launch ${label}: ${result.verdict.kind}`, verdict: result.verdict });
      }
      if (result.verdict.kind === "safe-attach") {
        const attached = await launchPersistentBrowser(lane, {});
        return jsonResult({ ok: true, attached: true, browser, lane, pid: attached.pid, message: `${label} already running with the matching profile; attach instead of launching.` });
      }
      const cfg = await loadConfig();
      const mode = resolveChromeMode(args.mode, cfg.chromeMode);
      try {
        assertModeSupported(browser, mode);
      } catch (err) {
        return jsonResult({ ok: false, error: (err as Error).message, lane });
      }
      if (args.dryRun) {
        const plan = await launchBrowserForLane(lane, { dryRun: true, binaryPath: args.binaryPath, mode });
        return jsonResult({
          ok: true,
          launched: false,
          browser,
          mode,
          lane,
          command: { binary: plan.binary, args: plan.args },
        });
      }
      const launch = await launchPersistentBrowser(lane, { binaryPath: args.binaryPath, mode });
      return jsonResult({
        ok: true,
        launched: !args.dryRun,
        browser,
        mode,
        lane,
        command: launch.command,
        pid: launch.pid,
        ...(browser === "firefox"
          ? { note: "Firefox lane: debug port serves WebDriver BiDi (ws://127.0.0.1:" + lane.chromeDebugPort + "/session), not Chrome CDP. Drive it with the page_* tools (page_goto/page_text/page_eval/page_click/page_fill/page_screenshot) — they speak BiDi for you." }
          : {}),
      });
    },
  );

  // ── PAGE CONTROL: one interface for every browser backend ───────────────
  // Firefox is driven over WebDriver BiDi, Chrome/Edge over CDP — same tools,
  // same semantics, so agents don't need protocol-specific fluency. Only the
  // lane's OWN browser (matching dedicated profile) is ever controlled.

  const pageToolTarget = {
    laneId: exactLaneId,
    owner: optionalOwner.describe("Lane owner. Required with cwd unless laneId is supplied."),
    cwd: optionalCwd.describe("Lane project directory. Required with owner unless laneId is supplied."),
    sessionId: z.string().optional().describe("Lane session id, if the lane was reserved with one."),
    tab: z.string().optional().describe("Which tab: an id from page_tabs, a 0-based index ('0','1',…), or a url/title substring (e.g. 'checkout'). Omit for the first tab. NOTE: Firefox tab ids change between calls — prefer index or substring for Firefox lanes."),
  };

  async function withPage(
    args: { laneId?: string; owner?: string; cwd?: string; sessionId?: string },
    fn: (page: PageController, lane: Lane) => Promise<Record<string, unknown>>,
  ) {
    const selected = await resolveToolLane(args);
    if (!selected.lane) return jsonResult({ ok: false, error: selected.error });
    const lane = selected.lane;
    let page: PageController | undefined;
    try {
      page = await openPageController(lane);
      const result = await fn(page, lane);
      return jsonResult({ ok: true, browser: page.browser, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResult({ ok: false, error: msg, ...(err instanceof PageControlError ? {} : { errorType: (err as Error).name }) });
    } finally {
      await page?.close();
    }
  }

  server.registerTool(
    "page_tabs",
    {
      title: "List the open tabs in a lane's browser",
      description:
        "List open tabs (id, url, title) in the lane's browser — works for chrome, edge (CDP), and firefox (WebDriver BiDi) lanes alike. " +
        "Tab ids feed the optional 'tab' argument of the other page_* tools. The lane's browser must already be running (use 'open').",
      inputSchema: { laneId: pageToolTarget.laneId, owner: pageToolTarget.owner, cwd: pageToolTarget.cwd, sessionId: pageToolTarget.sessionId },
    },
    async (args) => withPage(args, async (page) => ({ tabs: await page.tabs() })),
  );

  server.registerTool(
    "page_newtab",
    {
      title: "Open a new tab in a lane's EXISTING browser (RAM-friendly)",
      description:
        "Open an additional tab in the lane's already-running browser and (optionally) navigate it, returning the new tab's id/url/title. " +
        "PREFER THIS over reserving extra lanes with new sessionIds when you need several pages in the same project: a tab costs " +
        "~100-200 MB, while every extra lane is a WHOLE separate browser (~0.5-1.5 GB of RAM). Drive each tab independently via the " +
        "'tab' argument of the other page_* tools — on chrome/edge the returned tab id stays valid across calls; on firefox BiDi ids " +
        "are per-call, so address tabs by 0-based index ('1') or a url/title substring instead. Works on all lane browsers.",
      inputSchema: {
        laneId: pageToolTarget.laneId,
        owner: pageToolTarget.owner,
        cwd: pageToolTarget.cwd,
        sessionId: pageToolTarget.sessionId,
        url: z.string().optional().describe("Optional http/https/about/file/data URL to open in the new tab (waits for load)."),
      },
    },
    async (args) => withPage(args, async (page) => ({ tab: await page.newTab(args.url) })),
  );

  server.registerTool(
    "page_goto",
    {
      title: "Navigate a lane's browser tab and wait for the load to finish",
      description:
        "Navigate the lane's browser to a URL and wait until the document load completes, then return the final url + title as confirmation. " +
        "Works identically for chrome/edge (CDP) and firefox (BiDi) lanes.",
      inputSchema: { ...pageToolTarget, url: z.string().min(1).describe("http/https/about/file/data URL to open.") },
    },
    async (args) => withPage(args, async (page) => ({ page: await page.navigate(args.url, args.tab) })),
  );

  server.registerTool(
    "page_eval",
    {
      title: "Evaluate JavaScript in a lane's browser page",
      description:
        "Evaluate a JavaScript EXPRESSION in the page and return its value (awaited if it's a promise, JSON round-tripped). " +
        "Use for DOM inspection and page state: document.title, [...document.querySelectorAll('a')].map(a=>a.href), fetch(...).then(r=>r.json()), etc. " +
        "Multi-statement code must be wrapped in an IIFE: (()=>{ ...; return value })(). Works for chrome/edge (CDP) and firefox (BiDi) lanes.",
      inputSchema: { ...pageToolTarget, expression: z.string().min(1).describe("A single JS expression. Its (awaited) value is returned as JSON.") },
    },
    async (args) => withPage(args, async (page) => ({ value: await page.evalExpression(args.expression, args.tab) })),
  );

  server.registerTool(
    "page_text",
    {
      title: "Read the visible text of a lane's browser page",
      description:
        "Return the trimmed visible text of the page body, or of the first element matching a CSS selector. Capped at 20k chars " +
        "(truncated flag set when clipped). The cheap way to 'look at' a page without a screenshot.",
      inputSchema: { ...pageToolTarget, selector: z.string().optional().describe("Optional CSS selector; omit for the whole page body.") },
    },
    async (args) => withPage(args, async (page) => ({ result: await page.text(args.selector, args.tab) })),
  );

  server.registerTool(
    "page_click",
    {
      title: "Click an element in a lane's browser page",
      description:
        "Click the first element matching a CSS selector (scrolled into view first). Returns {clicked:false, error} when nothing matches. " +
        "Same behaviour on chrome/edge and firefox lanes.",
      inputSchema: { ...pageToolTarget, selector: z.string().min(1).describe("CSS selector of the element to click.") },
    },
    async (args) => withPage(args, async (page) => ({ result: await page.click(args.selector, args.tab) })),
  );

  server.registerTool(
    "page_fill",
    {
      title: "Fill a form field in a lane's browser page",
      description:
        "Set the value of the first input/textarea/select/contenteditable matching a CSS selector and dispatch the input/change events " +
        "frameworks listen for (React-safe native setter). Returns the resulting value as confirmation.",
      inputSchema: {
        ...pageToolTarget,
        selector: z.string().min(1).describe("CSS selector of the form control."),
        value: z.string().describe("The value to set."),
      },
    },
    async (args) => withPage(args, async (page) => ({ result: await page.fill(args.selector, args.value, args.tab) })),
  );

  server.registerTool(
    "page_screenshot",
    {
      title: "Screenshot a lane's browser tab to a PNG file",
      description:
        "Capture the tab as a PNG and save it to disk (default: ~/.portpilot/shots/<lane>-<ts>.png). Returns the file path — read it with " +
        "an image-capable tool if you need to see it. Works for chrome/edge (CDP) and firefox (BiDi) lanes.",
      inputSchema: { ...pageToolTarget, path: z.string().optional().describe("Optional output .png path. Default: ~/.portpilot/shots/.") },
    },
    async (args) => withPage(args, async (page) => ({ screenshot: await page.screenshot(args.path, args.tab) })),
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
