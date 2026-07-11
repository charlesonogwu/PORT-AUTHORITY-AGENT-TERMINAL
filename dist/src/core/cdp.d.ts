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
export declare class CdpError extends Error {
    constructor(message: string);
}
export interface CdpTarget {
    id: string;
    url: string;
    title?: string;
    webSocketDebuggerUrl?: string;
}
/** List page-type targets on a CDP port. */
export declare function listCdpPages(port: number, timeoutMs?: number): Promise<CdpTarget[]>;
/** Open a NEW tab via the HTTP endpoint and return its target descriptor.
 *  Modern Chrome/Edge require PUT for /json/new (GET is rejected). The tab
 *  opens on about:blank; navigation is the caller's job so the wait-for-load
 *  semantics stay identical to every other navigate. */
export declare function createCdpTab(port: number, timeoutMs?: number): Promise<CdpTarget>;
export declare class CdpClient {
    private ws;
    private nextId;
    private pending;
    private constructor();
    private rejectAll;
    /** Attach to one page target's websocket. */
    static connect(wsUrl: string, timeoutMs?: number): Promise<CdpClient>;
    send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Navigate and poll until document.readyState === "complete". */
    navigate(url: string): Promise<{
        url: string;
    }>;
    /** Runtime.evaluate returning the raw returnByValue value. */
    private evalRaw;
    /** Evaluate an expression that RETURNS A JSON STRING (see pagejs.ts). */
    evalJson(expression: string): Promise<unknown>;
    /** PNG screenshot of this page, as base64. */
    screenshot(): Promise<string>;
    close(): void;
}
