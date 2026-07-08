import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserKind, Lane, laneBrowser } from "./lane.js";
import { portpilotHome } from "./paths.js";
import { checkLane } from "./allocator.js";
import { isSafeInitialUrl } from "./chrome.js";
import { BidiClient } from "./bidi.js";
import { CdpClient, CdpError, listCdpPages } from "./cdp.js";
import { clickExpr, evalWrapperExpr, fillExpr, metaExpr, textExpr } from "./pagejs.js";

/**
 * The uniform page-control façade: ONE interface for driving a lane's
 * browser, routed to WebDriver BiDi (Firefox) or CDP (Chrome/Edge). This is
 * what makes Firefox as agent-controllable as Chrome/Edge — the MCP page_*
 * tools and `paat page` CLI both sit on top of this and never care which
 * protocol is underneath.
 *
 * Safety contract: openPageController REFUSES to drive a port unless the
 * lane's attach verdict is safe-attach — i.e. the process on the port is the
 * lane's own browser with the lane's own dedicated profile. PortPilot will
 * never inject JavaScript into a browser it did not launch (in particular,
 * never the user's personal browser).
 */

export const TEXT_CAP_CHARS = 20_000;

export interface PageTab {
  id: string;
  url: string;
  title?: string;
}

export class PageControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageControlError";
  }
}

export interface PageController {
  browser: BrowserKind;
  tabs(): Promise<PageTab[]>;
  navigate(url: string, tabId?: string): Promise<{ url: string; title: string }>;
  /** Evaluate a caller-supplied JS EXPRESSION; awaited and JSON round-tripped. */
  evalExpression(expression: string, tabId?: string): Promise<unknown>;
  text(selector: string | undefined, tabId?: string): Promise<{ found: boolean; truncated?: boolean; text: string }>;
  click(selector: string, tabId?: string): Promise<{ clicked: boolean; error?: string }>;
  fill(selector: string, value: string, tabId?: string): Promise<{ filled: boolean; value?: string; error?: string }>;
  /** Save a PNG screenshot; returns the absolute file path written. */
  screenshot(outFile: string | undefined, tabId?: string): Promise<{ path: string; bytes: number }>;
  /** ALWAYS await this (even on error paths). For Firefox it ends the BiDi
   *  session — skipping it leaves the port unusable until relaunch. */
  close(): Promise<void>;
}

/**
 * Resolve a caller's tab reference against the live tab list. Accepts, in
 * order: exact tab id, 0-based index ("0", "1", …), or a case-insensitive
 * url/title substring. Ids alone would be a trap: Firefox BiDi context ids
 * are scoped to the (per-command) session and change between calls, so
 * index/substring are the stable ways to address a Firefox tab.
 */
export function pickTab(tabs: PageTab[], ref: string | undefined): PageTab {
  if (tabs.length === 0) throw new PageControlError("browser has no open tabs");
  if (ref === undefined || ref === "") return tabs[0]!;
  const byId = tabs.find((t) => t.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) {
    const i = Number(ref);
    if (i < tabs.length) return tabs[i]!;
    throw new PageControlError(`tab index ${i} out of range — only ${tabs.length} tab(s) open`);
  }
  const q = ref.toLowerCase();
  const hit = tabs.find((t) => t.url.toLowerCase().includes(q) || (t.title ?? "").toLowerCase().includes(q));
  if (hit) return hit;
  throw new PageControlError(`no tab matches "${ref}" by id, index, or url/title substring — list tabs first`);
}

function assertNavigableUrl(url: string): void {
  if (!isSafeInitialUrl(url)) {
    throw new PageControlError(
      `refusing to navigate to "${url}" — URLs must use http/https/about/file/view-source/data scheme and must not begin with "-".`,
    );
  }
}

async function defaultShotPath(lane: Lane): Promise<string> {
  const dir = join(portpilotHome(), "shots");
  await mkdir(dir, { recursive: true });
  return join(dir, `${lane.id}-${Date.now()}.png`);
}

/** ── Firefox: WebDriver BiDi ─────────────────────────────────────────────── */

class BidiPageController implements PageController {
  readonly browser: BrowserKind = "firefox";
  constructor(
    private client: BidiClient,
    private lane: Lane,
  ) {}

  private async resolveContext(tabId?: string): Promise<string> {
    // Fast path: no ref or an exact context id — no per-tab title fetches.
    const contexts = await this.client.listContexts();
    if (contexts.length === 0) throw new PageControlError("Firefox has no open tabs");
    if (!tabId) return contexts[0]!.id;
    if (contexts.some((c) => c.id === tabId)) return tabId;
    // Index or substring ref — resolve against the full tab list (titles included).
    return pickTab(await this.tabs(), tabId).id;
  }

  async tabs(): Promise<PageTab[]> {
    const contexts = await this.client.listContexts();
    const out: PageTab[] = [];
    for (const c of contexts) {
      let title: string | undefined;
      try {
        const meta = (await this.client.evalJson(c.id, metaExpr())) as { title?: string };
        title = meta.title;
      } catch {
        /* tab may be mid-navigation; url alone is still useful */
      }
      out.push(title === undefined ? { id: c.id, url: c.url } : { id: c.id, url: c.url, title });
    }
    return out;
  }

  async navigate(url: string, tabId?: string): Promise<{ url: string; title: string }> {
    assertNavigableUrl(url);
    const ctx = await this.resolveContext(tabId);
    await this.client.navigate(ctx, url);
    const meta = (await this.client.evalJson(ctx, metaExpr())) as { url: string; title: string };
    return { url: meta.url, title: meta.title };
  }

  async evalExpression(expression: string, tabId?: string): Promise<unknown> {
    const ctx = await this.resolveContext(tabId);
    return this.client.evalJson(ctx, evalWrapperExpr(expression));
  }

  async text(selector: string | undefined, tabId?: string): Promise<{ found: boolean; truncated?: boolean; text: string }> {
    const ctx = await this.resolveContext(tabId);
    return (await this.client.evalJson(ctx, textExpr(selector, TEXT_CAP_CHARS))) as {
      found: boolean;
      truncated?: boolean;
      text: string;
    };
  }

  async click(selector: string, tabId?: string): Promise<{ clicked: boolean; error?: string }> {
    const ctx = await this.resolveContext(tabId);
    return (await this.client.evalJson(ctx, clickExpr(selector))) as { clicked: boolean; error?: string };
  }

  async fill(selector: string, value: string, tabId?: string): Promise<{ filled: boolean; value?: string; error?: string }> {
    const ctx = await this.resolveContext(tabId);
    return (await this.client.evalJson(ctx, fillExpr(selector, value))) as { filled: boolean; value?: string; error?: string };
  }

  async screenshot(outFile: string | undefined, tabId?: string): Promise<{ path: string; bytes: number }> {
    const ctx = await this.resolveContext(tabId);
    const b64 = await this.client.screenshot(ctx);
    const path = outFile ?? (await defaultShotPath(this.lane));
    const buf = Buffer.from(b64, "base64");
    await writeFile(path, buf);
    return { path, bytes: buf.length };
  }

  async close(): Promise<void> {
    await this.client.closeGracefully();
  }
}

/** ── Chrome / Edge: CDP ──────────────────────────────────────────────────── */

class CdpPageController implements PageController {
  readonly browser: BrowserKind;
  /** One attached client per target, opened lazily and reused. */
  private clients = new Map<string, CdpClient>();

  constructor(
    private port: number,
    private lane: Lane,
    browser: BrowserKind,
  ) {
    this.browser = browser;
  }

  private async resolveTarget(tabId?: string): Promise<{ id: string; wsUrl: string }> {
    const pages = await listCdpPages(this.port);
    if (pages.length === 0) throw new PageControlError("browser has no open page tabs");
    const picked = pickTab(
      pages.map((p) => (p.title === undefined ? { id: p.id, url: p.url } : { id: p.id, url: p.url, title: p.title })),
      tabId,
    );
    const page = pages.find((p) => p.id === picked.id)!;
    if (!page.webSocketDebuggerUrl) {
      throw new PageControlError(`tab ${page.id} has no webSocketDebuggerUrl — another client may hold its debugger`);
    }
    return { id: page.id, wsUrl: page.webSocketDebuggerUrl };
  }

  private async clientFor(tabId?: string): Promise<CdpClient> {
    const target = await this.resolveTarget(tabId);
    const existing = this.clients.get(target.id);
    if (existing) return existing;
    const client = await CdpClient.connect(target.wsUrl);
    this.clients.set(target.id, client);
    return client;
  }

  async tabs(): Promise<PageTab[]> {
    const pages = await listCdpPages(this.port);
    return pages.map((p) => (p.title === undefined ? { id: p.id, url: p.url } : { id: p.id, url: p.url, title: p.title }));
  }

  async navigate(url: string, tabId?: string): Promise<{ url: string; title: string }> {
    assertNavigableUrl(url);
    const client = await this.clientFor(tabId);
    await client.navigate(url);
    const meta = (await client.evalJson(metaExpr())) as { url: string; title: string };
    return { url: meta.url, title: meta.title };
  }

  async evalExpression(expression: string, tabId?: string): Promise<unknown> {
    const client = await this.clientFor(tabId);
    return client.evalJson(evalWrapperExpr(expression));
  }

  async text(selector: string | undefined, tabId?: string): Promise<{ found: boolean; truncated?: boolean; text: string }> {
    const client = await this.clientFor(tabId);
    return (await client.evalJson(textExpr(selector, TEXT_CAP_CHARS))) as { found: boolean; truncated?: boolean; text: string };
  }

  async click(selector: string, tabId?: string): Promise<{ clicked: boolean; error?: string }> {
    const client = await this.clientFor(tabId);
    return (await client.evalJson(clickExpr(selector))) as { clicked: boolean; error?: string };
  }

  async fill(selector: string, value: string, tabId?: string): Promise<{ filled: boolean; value?: string; error?: string }> {
    const client = await this.clientFor(tabId);
    return (await client.evalJson(fillExpr(selector, value))) as { filled: boolean; value?: string; error?: string };
  }

  async screenshot(outFile: string | undefined, tabId?: string): Promise<{ path: string; bytes: number }> {
    const client = await this.clientFor(tabId);
    const b64 = await client.screenshot();
    const path = outFile ?? (await defaultShotPath(this.lane));
    const buf = Buffer.from(b64, "base64");
    await writeFile(path, buf);
    return { path, bytes: buf.length };
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

/**
 * Open a controller for a lane's browser. Enforces the safety contract:
 * the port must hold OUR browser with OUR profile (verdict safe-attach).
 */
export async function openPageController(lane: Lane): Promise<PageController> {
  const port = lane.chromeDebugPort;
  if (typeof port !== "number" || port <= 0) {
    throw new PageControlError(`lane ${lane.id} has no debug port — reserve it with a browser port first`);
  }
  const check = await checkLane(lane);
  if (check.verdict.kind === "safe-free") {
    throw new PageControlError(
      `lane ${lane.id} has no browser running on port ${port}. Launch it first (open / launch_browser_lane).`,
    );
  }
  if (check.verdict.kind !== "safe-attach") {
    throw new PageControlError(
      `refusing to control port ${port}: ${check.verdict.kind} — the process there is not this lane's browser/profile.`,
    );
  }
  const browser = laneBrowser(lane);
  if (browser === "firefox") {
    const client = await BidiClient.connect(port);
    return new BidiPageController(client, lane);
  }
  try {
    return new CdpPageController(port, lane, browser);
  } catch (err) {
    if (err instanceof CdpError) throw new PageControlError(err.message);
    throw err;
  }
}
