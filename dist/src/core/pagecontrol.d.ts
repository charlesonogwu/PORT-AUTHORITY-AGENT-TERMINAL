import { BrowserKind, Lane } from "./lane.js";
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
export declare const TEXT_CAP_CHARS = 20000;
export interface PageTab {
    id: string;
    url: string;
    title?: string;
}
export declare class PageControlError extends Error {
    constructor(message: string);
}
export interface PageController {
    browser: BrowserKind;
    tabs(): Promise<PageTab[]>;
    /** Open a NEW tab in this lane's EXISTING browser (the RAM-friendly
     *  alternative to reserving another lane — a tab costs ~100-200 MB, a whole
     *  extra lane costs ~0.5-1.5 GB). Navigates it when `url` is given. */
    newTab(url?: string): Promise<PageTab>;
    navigate(url: string, tabId?: string): Promise<{
        url: string;
        title: string;
    }>;
    /** Evaluate a caller-supplied JS EXPRESSION; awaited and JSON round-tripped. */
    evalExpression(expression: string, tabId?: string): Promise<unknown>;
    text(selector: string | undefined, tabId?: string): Promise<{
        found: boolean;
        truncated?: boolean;
        text: string;
    }>;
    click(selector: string, tabId?: string): Promise<{
        clicked: boolean;
        error?: string;
    }>;
    fill(selector: string, value: string, tabId?: string): Promise<{
        filled: boolean;
        value?: string;
        error?: string;
    }>;
    /** Save a PNG screenshot; returns the absolute file path written. */
    screenshot(outFile: string | undefined, tabId?: string): Promise<{
        path: string;
        bytes: number;
    }>;
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
export declare function pickTab(tabs: PageTab[], ref: string | undefined): PageTab;
/**
 * Open a controller for a lane's browser. Enforces the safety contract:
 * the port must hold OUR browser with OUR profile (verdict safe-attach).
 */
export declare function openPageController(lane: Lane): Promise<PageController>;
