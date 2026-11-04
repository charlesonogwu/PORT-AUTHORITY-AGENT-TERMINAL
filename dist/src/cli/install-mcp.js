/**
 * `paat install-mcp <client>` — wire PAAT into a desktop AI agent's MCP
 * config file so the agent can spawn `paat mcp` without the user having
 * to hand-edit JSON / TOML.
 *
 * Currently supports:
 *   - Claude Desktop  → %APPDATA%\Claude\claude_desktop_config.json (JSON)
 *   - Codex Desktop   → ~/.codex/config.toml                         (TOML)
 *
 * Design constraints:
 *   1. Never corrupt an existing config — always back it up first.
 *   2. Never clobber other entries — preserve other MCP servers and any
 *      unrelated settings the user has in there.
 *   3. Be idempotent — running twice in a row is a no-op the second time.
 *   4. Refuse to silently rewrite a malformed config — throw a clear
 *      error pointing the user at the file path instead.
 *   5. Don't pull in a TOML parser dependency just for Codex. The Codex
 *      block is a fixed shape we can append textually; if a paat block
 *      already exists we leave it alone and report "already-installed."
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Canonical MCP server name we register everywhere. This is what users see
 * in Claude Code's /mcp view, Claude Desktop's MCP server list, and in any
 * tool prefixes the agent generates (e.g. `port-authority-agent-terminal:
 * reserve_lane`). We use kebab-case to match the npm package name and to
 * avoid shell-quoting headaches.
 */
export const MCP_SERVER_NAME = "port-authority-agent-terminal";
/**
 * Older names we've registered under in past versions. When the installer
 * finds an entry under one of these, it removes it as part of migrating to
 * the canonical MCP_SERVER_NAME above. This guarantees a user who upgrades
 * never ends up with duplicate entries in their MCP list.
 */
export const LEGACY_MCP_SERVER_NAMES = ["paat", "portpilot", "port-authority"];
/**
 * Compute the default { command, args } pair we register with MCP hosts.
 *
 * Why this exists (Windows root cause):
 *   Until v0.2.2 we wrote `command: "paat"` and let the host resolve it
 *   through PATH. That works on macOS/Linux but breaks on Windows: Electron
 *   apps (Claude Desktop, Codex Desktop) spawn subprocesses with shell:false,
 *   and on Windows that means `paat` resolves to the .cmd shim only if the
 *   spawner explicitly appends .cmd or runs through cmd.exe. They don't.
 *   Result: every Windows install showed "Server disconnected" in Claude
 *   Desktop until the user hand-edited the config to use node.exe directly.
 *
 * Fix: always write the absolute node.exe path + absolute path to our
 * compiled CLI script. This works on every host on every platform and has
 * no PATH lookup ambiguity.
 *
 *   command: process.execPath        — the node.exe that's running us right now
 *   args:    [<abs path to index.js>, "mcp"]
 *
 * Trade-off: if the user later moves Node or replaces it with a different
 * version, the entries we wrote point at the old node.exe. Re-running
 * `paat install-mcp` rewrites them. Acceptable: most users don't move Node
 * frequently, and our postinstall hook re-runs install-mcp on every upgrade
 * anyway, so it self-heals across `npm install -g` cycles.
 */
export function defaultMcpCommand() {
    // Resolve <pkg>/dist/src/cli/index.js relative to this file. Works whether
    // we're running from dist (production) or src (dev mode via tsx).
    const here = fileURLToPath(import.meta.url);
    // install-mcp.ts sits at dist/src/cli/install-mcp.js — its sibling is the
    // CLI entry. Same in src mode.
    const cliJs = here.replace(/install-mcp\.(?:js|ts)$/, "index.js");
    return {
        command: process.execPath, // absolute path to node.exe / node binary
        args: [cliJs, "mcp"],
    };
}
/** Resolves %APPDATA%\Claude\claude_desktop_config.json. Honors APPDATA env when present. */
export function claudeConfigPath() {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
}
/** Resolves ~/.codex/config.toml. */
export function codexConfigPath() {
    return join(homedir(), ".codex", "config.toml");
}
function makeBackupName(configPath) {
    // ISO timestamp with `:` and `.` swapped to `-` so it's a legal filename on Windows.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `${configPath}.backup-${ts}`;
}
async function readIfExists(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
/**
 * Install PAAT into the Claude Desktop MCP config. Merges into any existing
 * `mcpServers` block without clobbering other servers.
 */
export async function installClaudeMcp(opts = {}) {
    const configPath = opts.configPath ?? claudeConfigPath();
    // See defaultMcpCommand() — uses node.exe + absolute script path instead
    // of bare "paat" so Electron-based MCP hosts (Claude Desktop, Codex) can
    // spawn it on Windows where shell:false breaks .cmd-shim resolution.
    const __defaults = defaultMcpCommand();
    const command = opts.command ?? __defaults.command;
    const args = opts.args ?? __defaults.args;
    await mkdir(dirname(configPath), { recursive: true });
    const raw = await readIfExists(configPath);
    let existing = {};
    if (raw !== null && raw.trim().length > 0) {
        try {
            existing = JSON.parse(raw);
            if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
                throw new Error(`expected a JSON object at the root, got ${Array.isArray(existing) ? "array" : typeof existing}`);
            }
        }
        catch (err) {
            throw new Error(`could not parse existing Claude Desktop config (${configPath}): ${err.message}.\n` +
                `Fix the JSON manually, or delete the file and re-run \`paat install-mcp claude\`.`);
        }
    }
    // Backup the existing file if it had content (skip if creating a fresh one).
    let backupPath = null;
    if (raw !== null) {
        backupPath = makeBackupName(configPath);
        await copyFile(configPath, backupPath);
    }
    const mcpServers = existing.mcpServers ?? {};
    const existingBlock = mcpServers[MCP_SERVER_NAME];
    const newBlock = { command, args };
    // Migration: if an old PAAT entry exists under a legacy name (e.g. "paat"),
    // delete it now so the user doesn't end up with duplicate entries in
    // their MCP list after upgrading.
    let migratedLegacy = false;
    for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
        // Defensive guard: skip if a future LEGACY_MCP_SERVER_NAMES entry ever
        // duplicates the canonical name. Cast to string so TS doesn't flag the
        // comparison as impossible given today's literal types.
        if (legacyName === MCP_SERVER_NAME)
            continue; // safety: never delete the current name
        if (legacyName in mcpServers) {
            delete mcpServers[legacyName];
            migratedLegacy = true;
        }
    }
    let action;
    if (migratedLegacy) {
        // Any time we delete a legacy entry, the resulting write is meaningful
        // regardless of whether the canonical entry was already correct.
        action = "updated";
    }
    else if (existingBlock === undefined) {
        action = "installed";
    }
    else if (existingBlock.command === command &&
        JSON.stringify(existingBlock.args ?? []) === JSON.stringify(args)) {
        action = "already-installed";
    }
    else {
        action = "updated";
    }
    if (action === "already-installed") {
        return { client: "claude", configPath, backupPath, action };
    }
    mcpServers[MCP_SERVER_NAME] = newBlock;
    existing.mcpServers = mcpServers;
    await writeFile(configPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    return { client: "claude", configPath, backupPath, action };
}
/**
 * Install PAAT into the Codex Desktop MCP config (TOML). We do NOT pull in a
 * TOML parser — the block we add is a fixed shape that's safe to append
 * textually. If a `[mcp_servers.paat]` section already exists we don't
 * touch it (idempotent), and we don't try to silently rewrite a malformed
 * existing entry.
 */
export async function installCodexMcp(opts = {}) {
    const configPath = opts.configPath ?? codexConfigPath();
    // See defaultMcpCommand() — uses node.exe + absolute script path instead
    // of bare "paat" so Electron-based MCP hosts (Claude Desktop, Codex) can
    // spawn it on Windows where shell:false breaks .cmd-shim resolution.
    const __defaults = defaultMcpCommand();
    const command = opts.command ?? __defaults.command;
    const args = opts.args ?? __defaults.args;
    await mkdir(dirname(configPath), { recursive: true });
    const raw = await readIfExists(configPath);
    let backupPath = null;
    if (raw !== null) {
        backupPath = makeBackupName(configPath);
        await copyFile(configPath, backupPath);
    }
    // Helper: detect a [mcp_servers.<name>] section header (start-of-line, after
    // optional whitespace). We require the header to begin its line so we don't
    // false-match the literal text `[mcp_servers.foo]` appearing inside a string.
    const sectionHeaderRegex = (name) => new RegExp(`^[ \\t]*\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m");
    // 1. Cut any legacy [mcp_servers.<legacy>] section out of the file before
    //    writing the new one. We carve out the header line PLUS every
    //    subsequent line that isn't another section header / EOF, so the
    //    migrated config doesn't keep dead key/value pairs hanging around.
    let working = raw ?? "";
    for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
        // Defensive guard: skip if a future LEGACY_MCP_SERVER_NAMES entry ever
        // duplicates the canonical name. Cast to string so TS doesn't flag the
        // comparison as impossible given today's literal types.
        if (legacyName === MCP_SERVER_NAME)
            continue;
        const escaped = legacyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sectionBlockRegex = new RegExp(
        // The legacy section header line
        `^[ \\t]*\\[mcp_servers\\.${escaped}\\][^\\n]*\\n` +
            // Plus subsequent lines that are NOT a new section header
            `(?:^(?!\\s*\\[)[^\\n]*\\n?)*`, "gm");
        working = working.replace(sectionBlockRegex, "");
    }
    // Collapse any 3+ consecutive blank lines we may have created.
    working = working.replace(/\n{3,}/g, "\n\n");
    // 2. If the canonical section is already present and unchanged, exit early.
    //    (Note: we don't try to parse + diff existing TOML values — too fragile
    //    without a real TOML parser. We treat "header exists" as "installed".)
    if (sectionHeaderRegex(MCP_SERVER_NAME).test(working)) {
        // If we cut out a legacy section above, that's still a write — re-emit.
        if (working !== (raw ?? "")) {
            await writeFile(configPath, working, "utf8");
            return { client: "codex", configPath, backupPath, action: "updated" };
        }
        return { client: "codex", configPath, backupPath, action: "already-installed" };
    }
    // 3. Append the new section. TOML inline-array syntax happens to be a
    //    subset of JSON, so JSON.stringify on the args produces a valid TOML
    //    right-hand side.
    const argsToml = JSON.stringify(args);
    const block = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${JSON.stringify(command)}\nargs = ${argsToml}\n`;
    const prefix = working;
    const needsBlankLine = prefix.length > 0 && !prefix.endsWith("\n\n");
    const sep = prefix.length === 0 ? "" : prefix.endsWith("\n") ? (needsBlankLine ? "\n" : "") : "\n\n";
    await writeFile(configPath, prefix + sep + block, "utf8");
    return {
        client: "codex",
        configPath,
        backupPath,
        action: working !== (raw ?? "") ? "updated" : "installed",
    };
}
/**
 * Quote a single shell argument so concatenation into a command line is safe.
 * On Windows we double-quote anything with whitespace or shell metacharacters
 * and escape internal double quotes by doubling them (cmd.exe convention).
 * On POSIX we single-quote, escaping any internal single quotes.
 */
function quoteShellArg(arg) {
    if (process.platform === "win32") {
        if (/[\s&|<>^"]/.test(arg) || arg.length === 0) {
            return '"' + arg.replace(/"/g, '""') + '"';
        }
        return arg;
    }
    // POSIX: single-quote everything and escape internal single quotes.
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}
/**
 * Wraps a Claude Code subcommand call. Background:
 *
 *   - On Windows, npm-installed binaries are .cmd shims. Per CVE-2024-27980,
 *     Node ≥18 refuses to spawn a .cmd/.bat file WITHOUT shell:true. So we
 *     have to use shell:true on Windows.
 *   - With shell:true, Node's DEP0190 deprecation fires if you pass args
 *     separately (Node concatenates without escaping → injection risk).
 *
 * The fix that satisfies both: build the command line ourselves with
 * proper shell quoting, then call spawn with the FULL command string
 * and an empty args array. Node sees no args to "unsafely concatenate"
 * (we already did it, safely), and the shell still resolves .cmd shims.
 */
const defaultClaudeRunner = (claudeBin, args) => new Promise((resolve) => {
    const cmdLine = [claudeBin, ...args].map(quoteShellArg).join(" ");
    const child = spawn(cmdLine, [], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: stderr + String(err), code: -1 }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr, code: code ?? -1 }));
});
/**
 * Parse `claude mcp list` output looking for a specific server name. Format:
 *   "<name>: <command> - ✓ Connected"
 *   "<name>: <command> - ! Failed to connect"
 * Returns whether it exists and (best-effort) the command string.
 */
export function parseMcpListLine(listStdout, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fullRegex = new RegExp(`^${escaped}:\\s*(.+?)\\s*-\\s*[✓✗⚠!✓-]`, "u");
    const headRegex = new RegExp(`^${escaped}:`);
    for (const line of listStdout.split(/\r?\n/)) {
        const m = fullRegex.exec(line);
        if (m && m[1])
            return { exists: true, command: m[1].trim() };
        if (headRegex.test(line))
            return { exists: true, command: null };
    }
    return { exists: false, command: null };
}
/**
 * Backwards-compatible alias retained for tests still calling the old name.
 * Equivalent to parseMcpListLine(stdout, "paat").
 */
export function parseExistingPaatLine(listStdout) {
    return parseMcpListLine(listStdout, "paat");
}
/**
 * Install (or update, or no-op) the PAAT MCP server entry in Claude Code's
 * configuration. Delegates to the `claude` CLI so we don't have to encode
 * Claude Code's config format ourselves (it can change between releases).
 *
 * Failure modes:
 *   - `claude` not on PATH                -> clear error with install link
 *   - `claude mcp list` errored           -> propagate stderr
 *   - `claude mcp add` errored            -> propagate stderr
 *
 * Idempotency:
 *   - Parses `claude mcp list` first.
 *   - If paat already present with the same command -> "already-installed", no write.
 *   - If paat already present with a different command -> remove + add ("updated").
 *   - Otherwise -> add ("installed").
 */
export async function installClaudeCodeMcp(opts = {}) {
    const claudeBin = opts.claudeBin ?? "claude";
    const scope = opts.scope ?? "user";
    // See defaultMcpCommand() — uses node.exe + absolute script path instead
    // of bare "paat" so Electron-based MCP hosts (Claude Desktop, Codex) can
    // spawn it on Windows where shell:false breaks .cmd-shim resolution.
    const __defaults = defaultMcpCommand();
    const command = opts.command ?? __defaults.command;
    const args = opts.args ?? __defaults.args;
    const run = opts.runner ?? defaultClaudeRunner;
    // 1. Sanity-check that claude is reachable. If not, return "skipped" rather
    //    than throwing — that way `paat install-mcp` (all clients) doesn't fail
    //    loudly during a postinstall on machines that only use Claude Desktop or
    //    only Codex. The reason field carries the install hint if the user wants
    //    to set up Claude Code later.
    const probe = await run(claudeBin, ["--version"]);
    if (!probe.ok) {
        return {
            client: "claude-code",
            configPath: "<claude CLI not installed>",
            backupPath: null,
            action: "skipped",
            reason: `'${claudeBin}' is not on PATH. Install Claude Code from ` +
                `https://docs.claude.com/en/claude-code/quickstart, then run ` +
                `\`paat install-mcp claude-code\` to wire it up.`,
        };
    }
    // 2. Check whether PAAT is already registered — under either the canonical
    //    name OR any legacy name. Legacy entries get migrated (removed) so the
    //    user doesn't end up with duplicate rows in their /mcp view.
    const list = await run(claudeBin, ["mcp", "list"]);
    if (!list.ok) {
        throw new Error(`\`claude mcp list\` failed (exit ${list.code}): ${list.stderr.trim() || "(no stderr)"}`);
    }
    const expectedCommand = [command, ...args].join(" ");
    const reportedPath = `${homedir()}${join("/", ".claude.json")} (managed by claude CLI, scope=${scope})`;
    // 2a. Migrate any legacy entries first (regardless of whether the new name
    //     is present). After this loop, only the canonical entry should remain
    //     for our project.
    let migratedLegacy = false;
    for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
        // Defensive guard: skip if a future LEGACY_MCP_SERVER_NAMES entry ever
        // duplicates the canonical name. Cast to string so TS doesn't flag the
        // comparison as impossible given today's literal types.
        if (legacyName === MCP_SERVER_NAME)
            continue;
        const legacy = parseMcpListLine(list.stdout, legacyName);
        if (!legacy.exists)
            continue;
        const removed = await run(claudeBin, ["mcp", "remove", legacyName, "--scope", scope]);
        if (!removed.ok) {
            // Migration is best-effort — if remove fails (e.g. wrong scope), we log
            // it via the thrown error rather than silently leaving the duplicate.
            throw new Error(`\`claude mcp remove ${legacyName}\` failed during migration (exit ${removed.code}): ` +
                `${removed.stderr.trim() || "(no stderr)"}.\n` +
                `Run \`${claudeBin} mcp remove ${legacyName}\` manually, then re-run \`paat install-mcp claude-code\`.`);
        }
        migratedLegacy = true;
    }
    // 2b. Now check the canonical name.
    const existing = parseMcpListLine(list.stdout, MCP_SERVER_NAME);
    if (existing.exists && existing.command === expectedCommand && !migratedLegacy) {
        return {
            client: "claude-code",
            configPath: reportedPath,
            backupPath: null,
            action: "already-installed",
        };
    }
    // 3a. If the canonical entry exists with a different command, remove it
    //     first so we can re-add with the right one.
    let action = migratedLegacy ? "updated" : "installed";
    if (existing.exists) {
        action = "updated";
        const removed = await run(claudeBin, ["mcp", "remove", MCP_SERVER_NAME, "--scope", scope]);
        if (!removed.ok) {
            throw new Error(`\`claude mcp remove ${MCP_SERVER_NAME}\` failed before re-adding (exit ${removed.code}): ` +
                `${removed.stderr.trim() || "(no stderr)"}.\n` +
                `You may need to remove it manually with: ${claudeBin} mcp remove ${MCP_SERVER_NAME}`);
        }
    }
    // 3b. Add fresh under the canonical name.
    const addArgs = [
        "mcp",
        "add",
        "--transport",
        "stdio",
        MCP_SERVER_NAME,
        "--scope",
        scope,
        "--",
        command,
        ...args,
    ];
    const added = await run(claudeBin, addArgs);
    if (!added.ok) {
        throw new Error(`\`claude mcp add\` failed (exit ${added.code}): ${added.stderr.trim() || "(no stderr)"}`);
    }
    return { client: "claude-code", configPath: reportedPath, backupPath: null, action };
}
/* -------------------------------------------------------------------------- */
/*  Dispatcher                                                                */
/* -------------------------------------------------------------------------- */
export async function installMcpFor(client, opts = {}) {
    if (client === "claude")
        return installClaudeMcp(opts);
    if (client === "claude-code")
        return installClaudeCodeMcp({});
    if (client === "codex")
        return installCodexMcp(opts);
    throw new Error(`unknown MCP client: ${client}. Supported: claude, claude-code, codex.`);
}
