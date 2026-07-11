/**
 * Minimal WebDriver BiDi client for Firefox lanes.
 *
 * Firefox's `--remote-debugging-port` serves BiDi at ws://127.0.0.1:<port>/session.
 * Protocol: JSON commands {id, method, params} → {type:"success"|"error", id, result}.
 * We only need the command/response half — no event subscriptions.
 *
 * Uses Node's built-in WebSocket (Node ≥ 22) — no dependencies.
 */
export declare class BidiError extends Error {
    constructor(message: string);
}
export declare class BidiClient {
    private ws;
    private nextId;
    private pending;
    private constructor();
    private rejectAll;
    /** Connect to a Firefox lane's BiDi endpoint and open a session. */
    static connect(port: number, timeoutMs?: number): Promise<BidiClient>;
    send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Top-level browsing contexts (tabs). */
    listContexts(): Promise<Array<{
        id: string;
        url: string;
    }>>;
    /** Open a NEW top-level context (tab) and return its id. */
    createContext(): Promise<string>;
    /** Navigate a context and wait for the load to complete. */
    navigate(contextId: string, url: string): Promise<{
        url: string;
    }>;
    /**
     * Evaluate an expression that RETURNS A JSON STRING (see pagejs.ts) and
     * parse it. Page exceptions surface as BidiError with the page's message.
     */
    evalJson(contextId: string, expression: string): Promise<unknown>;
    /** PNG screenshot of a context, as base64. */
    screenshot(contextId: string): Promise<string>;
    close(): void;
    /**
     * End the BiDi session BEFORE closing the socket. This matters: Firefox
     * allows exactly one active session, and an abruptly-dropped connection
     * leaves that session alive FOREVER — bricking the port for every future
     * controller until Firefox is relaunched. Verified against Firefox 152.
     */
    closeGracefully(): Promise<void>;
}
