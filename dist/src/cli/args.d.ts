/**
 * Tiny argument parser. We deliberately avoid yargs/commander to keep the
 * dependency surface zero — agents installing portpilot get a 1-MB binary,
 * not a 30-MB CLI framework.
 */
export interface ParsedArgs {
    command: string;
    positional: string[];
    flags: Record<string, string | boolean>;
}
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function flagString(args: ParsedArgs, name: string, fallback?: string): string | undefined;
export declare function flagBool(args: ParsedArgs, name: string, fallback?: boolean): boolean;
export declare function flagInt(args: ParsedArgs, name: string): number | undefined;
export declare function parsePortRange(spec: string | undefined): {
    start: number;
    end: number;
} | undefined;
/**
 * Parse a human-readable duration string into milliseconds.
 *   "30s"   →    30_000
 *   "5m"    →   300_000
 *   "1h"    → 3_600_000
 *   "7d"    → 604_800_000
 * Returns undefined for unparseable input.
 */
export declare function parseDurationMs(spec: string | undefined): number | undefined;
