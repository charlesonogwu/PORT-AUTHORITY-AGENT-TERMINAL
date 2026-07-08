/**
 * Minimal WebDriver BiDi client for Firefox lanes.
 *
 * Firefox's `--remote-debugging-port` serves BiDi at ws://127.0.0.1:<port>/session.
 * Protocol: JSON commands {id, method, params} → {type:"success"|"error", id, result}.
 * We only need the command/response half — no event subscriptions.
 *
 * Uses Node's built-in WebSocket (Node ≥ 22) — no dependencies.
 */

const COMMAND_TIMEOUT_MS = 20_000;

interface BidiResponse {
  type: "success" | "error";
  id?: number;
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

export class BidiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BidiError";
  }
}

export class BidiClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: BidiResponse) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let msg: BidiResponse;
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
    ws.onclose = () => this.rejectAll(new BidiError("BiDi connection closed"));
    ws.onerror = () => this.rejectAll(new BidiError("BiDi connection error"));
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Connect to a Firefox lane's BiDi endpoint and open a session. */
  static async connect(port: number, timeoutMs = 10_000): Promise<BidiClient> {
    const url = `ws://127.0.0.1:${port}/session`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(url);
      const t = setTimeout(() => {
        w.close();
        reject(new BidiError(`timed out connecting to ${url} — is the lane's Firefox running?`));
      }, timeoutMs);
      w.onopen = () => {
        clearTimeout(t);
        resolve(w);
      };
      w.onerror = () => {
        clearTimeout(t);
        reject(new BidiError(`could not connect to ${url} — is the lane's Firefox running?`));
      };
    });
    const client = new BidiClient(ws);
    try {
      await client.send("session.new", { capabilities: {} });
    } catch (err) {
      client.close();
      const msg = err instanceof Error ? err.message : String(err);
      if (/maximum number of active sessions/i.test(msg)) {
        throw new BidiError(
          "Firefox already has an active BiDi session (a previous controller disconnected without session.end, " +
            "or another client such as Playwright is attached). Firefox only allows one; relaunch the lane's " +
            "Firefox (kill it, then 'open'/'launch_browser_lane' again) to reset.",
        );
      }
      throw err;
    }
    return client;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await new Promise<BidiResponse>((resolve, reject) => {
      // The timer must be CLEARED on response and UNREF'd: a lingering timer
      // keeps the Node event loop alive ~20s after every command, which makes
      // one-shot CLI invocations hang long past their useful work.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new BidiError(`BiDi command ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`));
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
    if (res.type === "error") {
      throw new BidiError(`BiDi ${method} failed: ${res.error ?? "unknown"} — ${res.message ?? ""}`.trim());
    }
    return res.result ?? {};
  }

  /** Top-level browsing contexts (tabs). */
  async listContexts(): Promise<Array<{ id: string; url: string }>> {
    const result = await this.send("browsingContext.getTree", {});
    const contexts = (result.contexts as Array<{ context: string; url: string }>) ?? [];
    return contexts.map((c) => ({ id: c.context, url: c.url }));
  }

  /** Navigate a context and wait for the load to complete. */
  async navigate(contextId: string, url: string): Promise<{ url: string }> {
    const result = await this.send("browsingContext.navigate", { context: contextId, url, wait: "complete" });
    return { url: (result.url as string) ?? url };
  }

  /**
   * Evaluate an expression that RETURNS A JSON STRING (see pagejs.ts) and
   * parse it. Page exceptions surface as BidiError with the page's message.
   */
  async evalJson(contextId: string, expression: string): Promise<unknown> {
    const result = await this.send("script.evaluate", {
      expression,
      target: { context: contextId },
      awaitPromise: true,
    });
    if (result.type === "exception") {
      const details = result.exceptionDetails as { text?: string } | undefined;
      throw new BidiError(`page JavaScript threw: ${details?.text ?? JSON.stringify(details ?? {}).slice(0, 300)}`);
    }
    const value = (result.result as { type?: string; value?: unknown } | undefined)?.value;
    if (typeof value !== "string") {
      throw new BidiError(`expected a JSON string from the page, got ${JSON.stringify(value)?.slice(0, 120)}`);
    }
    return JSON.parse(value);
  }

  /** PNG screenshot of a context, as base64. */
  async screenshot(contextId: string): Promise<string> {
    const result = await this.send("browsingContext.captureScreenshot", { context: contextId });
    const data = result.data as string | undefined;
    if (!data) throw new BidiError("captureScreenshot returned no data");
    return data;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * End the BiDi session BEFORE closing the socket. This matters: Firefox
   * allows exactly one active session, and an abruptly-dropped connection
   * leaves that session alive FOREVER — bricking the port for every future
   * controller until Firefox is relaunched. Verified against Firefox 152.
   */
  async closeGracefully(): Promise<void> {
    try {
      await this.send("session.end", {});
    } catch {
      /* session already gone or socket dead — nothing more we can do */
    }
    this.close();
  }
}
