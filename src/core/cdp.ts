/**
 * Minimal Chrome DevTools Protocol client for Chrome/Edge lanes.
 *
 * Targets come from http://127.0.0.1:<port>/json/list; each page target has a
 * webSocketDebuggerUrl we attach to. Same command/response discipline as the
 * BiDi client, and the same pagejs.ts snippets — so Chrome, Edge, and Firefox
 * behave identically from the caller's point of view.
 *
 * Uses Node's built-in fetch + WebSocket — no dependencies.
 */

const COMMAND_TIMEOUT_MS = 20_000;
const NAV_POLL_INTERVAL_MS = 250;
const NAV_TIMEOUT_MS = 20_000;

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

export interface CdpTarget {
  id: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/** List page-type targets on a CDP port. */
export async function listCdpPages(port: number, timeoutMs = 5_000): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new CdpError(`could not reach CDP on http://127.0.0.1:${port}/json/list — is the lane's browser running?`);
  }
  const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title?: string; webSocketDebuggerUrl?: string }>;
  return targets
    .filter((t) => t.type === "page")
    .map((t) => {
      const out: CdpTarget = { id: t.id, url: t.url };
      if (t.title !== undefined) out.title = t.title;
      if (t.webSocketDebuggerUrl !== undefined) out.webSocketDebuggerUrl = t.webSocketDebuggerUrl;
      return out;
    });
}

/** Open a NEW tab via the HTTP endpoint and return its target descriptor.
 *  Modern Chrome/Edge require PUT for /json/new (GET is rejected). The tab
 *  opens on about:blank; navigation is the caller's job so the wait-for-load
 *  semantics stay identical to every other navigate. */
export async function createCdpTab(port: number, timeoutMs = 5_000): Promise<CdpTarget> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new CdpError(`could not reach CDP on http://127.0.0.1:${port}/json/new — is the lane's browser running?`);
  }
  if (!res.ok) {
    throw new CdpError(`CDP /json/new failed: HTTP ${res.status}`);
  }
  const t = (await res.json()) as { id: string; url: string; title?: string; webSocketDebuggerUrl?: string };
  const out: CdpTarget = { id: t.id, url: t.url };
  if (t.title !== undefined) out.title = t.title;
  if (t.webSocketDebuggerUrl !== undefined) out.webSocketDebuggerUrl = t.webSocketDebuggerUrl;
  return out;
}

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

export class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: CdpResponse) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let msg: CdpResponse;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!.resolve(msg);
        this.pending.delete(msg.id);
      }
    };
    ws.onclose = () => this.rejectAll(new CdpError("CDP connection closed"));
    ws.onerror = () => this.rejectAll(new CdpError("CDP connection error"));
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Attach to one page target's websocket. */
  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(wsUrl);
      const t = setTimeout(() => {
        w.close();
        reject(new CdpError(`timed out attaching to ${wsUrl}`));
      }, timeoutMs);
      w.onopen = () => {
        clearTimeout(t);
        resolve(w);
      };
      w.onerror = () => {
        clearTimeout(t);
        reject(new CdpError(`could not attach to ${wsUrl}`));
      };
    });
    return new CdpClient(ws);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await new Promise<CdpResponse>((resolve, reject) => {
      // Cleared on response + unref'd — a lingering timer would keep one-shot
      // CLI processes alive ~20s after the work is done.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new CdpError(`CDP command ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
        }
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    if (res.error) {
      throw new CdpError(`CDP ${method} failed: ${res.error.message ?? "unknown error"}`);
    }
    return res.result ?? {};
  }

  /** Navigate and poll until document.readyState === "complete". */
  async navigate(url: string): Promise<{ url: string }> {
    const nav = await this.send("Page.navigate", { url });
    if (typeof nav.errorText === "string" && nav.errorText.length > 0) {
      throw new CdpError(`navigation failed: ${nav.errorText}`);
    }
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = (await this.evalRaw("document.readyState")) as string;
      if (state === "complete") {
        const finalUrl = (await this.evalRaw("location.href")) as string;
        return { url: finalUrl };
      }
      await new Promise((r) => setTimeout(r, NAV_POLL_INTERVAL_MS));
    }
    throw new CdpError(`navigation to ${url} did not reach readyState=complete within ${NAV_TIMEOUT_MS}ms`);
  }

  /** Runtime.evaluate returning the raw returnByValue value. */
  private async evalRaw(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    if (details) {
      throw new CdpError(`page JavaScript threw: ${details.exception?.description ?? details.text ?? "unknown error"}`);
    }
    return (result.result as { value?: unknown } | undefined)?.value;
  }

  /** Evaluate an expression that RETURNS A JSON STRING (see pagejs.ts). */
  async evalJson(expression: string): Promise<unknown> {
    const value = await this.evalRaw(expression);
    if (typeof value !== "string") {
      throw new CdpError(`expected a JSON string from the page, got ${JSON.stringify(value)?.slice(0, 120)}`);
    }
    return JSON.parse(value);
  }

  /** PNG screenshot of this page, as base64. */
  async screenshot(): Promise<string> {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    const data = result.data as string | undefined;
    if (!data) throw new CdpError("captureScreenshot returned no data");
    return data;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
