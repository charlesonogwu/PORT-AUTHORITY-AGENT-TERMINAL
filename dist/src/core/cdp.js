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
    constructor(message) {
        super(message);
        this.name = "CdpError";
    }
}
/** List page-type targets on a CDP port. */
export async function listCdpPages(port, timeoutMs = 5_000) {
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    }
    catch {
        throw new CdpError(`could not reach CDP on http://127.0.0.1:${port}/json/list — is the lane's browser running?`);
    }
    const targets = (await res.json());
    return targets
        .filter((t) => t.type === "page")
        .map((t) => {
        const out = { id: t.id, url: t.url };
        if (t.title !== undefined)
            out.title = t.title;
        if (t.webSocketDebuggerUrl !== undefined)
            out.webSocketDebuggerUrl = t.webSocketDebuggerUrl;
        return out;
    });
}
/** Open a NEW tab via the HTTP endpoint and return its target descriptor.
 *  Modern Chrome/Edge require PUT for /json/new (GET is rejected). The tab
 *  opens on about:blank; navigation is the caller's job so the wait-for-load
 *  semantics stay identical to every other navigate. */
export async function createCdpTab(port, timeoutMs = 5_000) {
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT", signal: AbortSignal.timeout(timeoutMs) });
    }
    catch {
        throw new CdpError(`could not reach CDP on http://127.0.0.1:${port}/json/new — is the lane's browser running?`);
    }
    if (!res.ok) {
        throw new CdpError(`CDP /json/new failed: HTTP ${res.status}`);
    }
    const t = (await res.json());
    const out = { id: t.id, url: t.url };
    if (t.title !== undefined)
        out.title = t.title;
    if (t.webSocketDebuggerUrl !== undefined)
        out.webSocketDebuggerUrl = t.webSocketDebuggerUrl;
    return out;
}
export class CdpClient {
    ws;
    nextId = 1;
    pending = new Map();
    constructor(ws) {
        this.ws = ws;
        ws.onmessage = (ev) => {
            let msg;
            try {
                msg = JSON.parse(String(ev.data));
            }
            catch {
                return;
            }
            if (typeof msg.id === "number" && this.pending.has(msg.id)) {
                this.pending.get(msg.id).resolve(msg);
                this.pending.delete(msg.id);
            }
        };
        ws.onclose = () => this.rejectAll(new CdpError("CDP connection closed"));
        ws.onerror = () => this.rejectAll(new CdpError("CDP connection error"));
    }
    rejectAll(err) {
        for (const p of this.pending.values())
            p.reject(err);
        this.pending.clear();
    }
    /** Attach to one page target's websocket. */
    static async connect(wsUrl, timeoutMs = 10_000) {
        const ws = await new Promise((resolve, reject) => {
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
    async send(method, params = {}) {
        const id = this.nextId++;
        const res = await new Promise((resolve, reject) => {
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
    async navigate(url) {
        const nav = await this.send("Page.navigate", { url });
        if (typeof nav.errorText === "string" && nav.errorText.length > 0) {
            throw new CdpError(`navigation failed: ${nav.errorText}`);
        }
        const deadline = Date.now() + NAV_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const state = (await this.evalRaw("document.readyState"));
            if (state === "complete") {
                const finalUrl = (await this.evalRaw("location.href"));
                return { url: finalUrl };
            }
            await new Promise((r) => setTimeout(r, NAV_POLL_INTERVAL_MS));
        }
        throw new CdpError(`navigation to ${url} did not reach readyState=complete within ${NAV_TIMEOUT_MS}ms`);
    }
    /** Runtime.evaluate returning the raw returnByValue value. */
    async evalRaw(expression) {
        const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        const details = result.exceptionDetails;
        if (details) {
            throw new CdpError(`page JavaScript threw: ${details.exception?.description ?? details.text ?? "unknown error"}`);
        }
        return result.result?.value;
    }
    /** Evaluate an expression that RETURNS A JSON STRING (see pagejs.ts). */
    async evalJson(expression) {
        const value = await this.evalRaw(expression);
        if (typeof value !== "string") {
            throw new CdpError(`expected a JSON string from the page, got ${JSON.stringify(value)?.slice(0, 120)}`);
        }
        return JSON.parse(value);
    }
    /** PNG screenshot of this page, as base64. */
    async screenshot() {
        const result = await this.send("Page.captureScreenshot", { format: "png" });
        const data = result.data;
        if (!data)
            throw new CdpError("captureScreenshot returned no data");
        return data;
    }
    close() {
        try {
            this.ws.close();
        }
        catch {
            /* already closed */
        }
    }
}
