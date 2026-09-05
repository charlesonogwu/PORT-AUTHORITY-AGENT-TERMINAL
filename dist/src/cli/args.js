/**
 * Tiny argument parser. We deliberately avoid yargs/commander to keep the
 * dependency surface zero — agents installing portpilot get a 1-MB binary,
 * not a 30-MB CLI framework.
 */
export function parseArgs(argv) {
    const [first, ...rest] = argv;
    const command = first ?? "help";
    const positional = [];
    const flags = {};
    const setFlag = (key, value) => {
        const previous = flags[key];
        if (typeof value === "string" && typeof previous === "string")
            flags[key] = [previous, value];
        else if (typeof value === "string" && Array.isArray(previous))
            flags[key] = [...previous, value];
        else
            flags[key] = value;
    };
    for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token === "--") {
            positional.push(...rest.slice(i + 1));
            break;
        }
        if (token.startsWith("--")) {
            const eq = token.indexOf("=");
            if (eq !== -1) {
                setFlag(token.slice(2, eq), token.slice(eq + 1));
                continue;
            }
            const key = token.slice(2);
            const next = rest[i + 1];
            if (next === undefined || next.startsWith("--") || next.startsWith("-")) {
                setFlag(key, true);
            }
            else {
                setFlag(key, next);
                i++;
            }
            continue;
        }
        if (token.startsWith("-") && token.length > 1) {
            flags[token.slice(1)] = true;
            continue;
        }
        positional.push(token);
    }
    return { command, positional, flags };
}
export function flagString(args, name, fallback) {
    const v = args.flags[name];
    if (typeof v === "string")
        return v;
    if (Array.isArray(v))
        return v[v.length - 1];
    if (v === true)
        return undefined;
    return fallback;
}
export function flagStrings(args, name) {
    const value = args.flags[name];
    if (typeof value === "string")
        return [value];
    return Array.isArray(value) ? value : [];
}
export function flagBool(args, name, fallback = false) {
    const v = args.flags[name];
    if (v === true)
        return true;
    if (typeof v === "string")
        return v !== "false" && v !== "0";
    return fallback;
}
export function flagInt(args, name) {
    const v = args.flags[name];
    if (typeof v !== "string")
        return undefined;
    const n = Number(v);
    return Number.isInteger(n) ? n : undefined;
}
export function parsePortRange(spec) {
    if (!spec)
        return undefined;
    const m = /^(\d+)-(\d+)$/.exec(spec.trim());
    if (!m)
        return undefined;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start)
        return undefined;
    return { start, end };
}
/**
 * Parse a human-readable duration string into milliseconds.
 *   "30s"   →    30_000
 *   "5m"    →   300_000
 *   "1h"    → 3_600_000
 *   "7d"    → 604_800_000
 * Returns undefined for unparseable input.
 */
export function parseDurationMs(spec) {
    if (!spec)
        return undefined;
    const m = /^(\d+)\s*(s|m|h|d)$/i.exec(spec.trim());
    if (!m)
        return undefined;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 0)
        return undefined;
    const unit = m[2].toLowerCase();
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return n * mult[unit];
}
