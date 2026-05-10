/**
 * Identify which LLM agent is driving an "external" Chrome instance —
 * one that didn't go through `paat reserve` / `paat open` first.
 *
 * Three signal sources, in order of strength:
 *
 *   1. Process ancestry. Walk up from chrome.exe via Win32 ParentProcessId.
 *      If any ancestor's name or command line matches a known agent
 *      signature (e.g. node running `codex/main.js`, or `Cursor.exe`),
 *      that's a high-confidence call.
 *
 *   2. CDP WebSocket peer. Whoever is actually driving Chrome is connected
 *      to its --remote-debugging-port via WebSocket. Get-NetTCPConnection
 *      tells us which local PID owns the client side. We then walk THAT
 *      process's ancestry too — the agent often spawns Playwright/
 *      Puppeteer as a child, so the immediate peer is a node process and
 *      its parent is the agent.
 *
 *   3. Profile-path keyword. Last-resort heuristic, kept for compatibility
 *      with the legacy inferOwnerFromProfile path.
 *
 * Returns "external" with confidence "none" when nothing matches. The
 * `evidence` array is human-readable text the dashboard can show on hover
 * so the user understands WHY portpilot thinks it's a particular agent.
 */
/**
 * Order matters: the FIRST matching signature wins. List the most specific
 * patterns first so e.g. `claude-code` doesn't match a generic substring.
 */
const SIGNATURES = [
    // Codex (OpenAI). Two flavours: the `codex` CLI from npm and the older
    // `chatgpt-codex` package. Both end up as node running a script whose
    // path contains "codex".
    {
        agent: "codex",
        test: (r) => /[\\/]codex[\\/](?:dist|bin|cli|lib|src)[\\/]/i.test(r.commandLine) ||
            /[\\/]@openai[\\/]codex/i.test(r.commandLine) ||
            /\bcodex(?:-cli)?\b.*\.js/i.test(r.commandLine) ||
            /^codex(\.exe)?$/i.test(r.name),
    },
    // Claude Code (Anthropic). Either the `claude` standalone binary or
    // node running @anthropic-ai/claude-code.
    {
        agent: "claude",
        test: (r) => /^claude(\.exe)?$/i.test(r.name) ||
            /@anthropic-ai[\\/]claude-code/i.test(r.commandLine) ||
            /[\\/]claude-code[\\/](?:dist|bin|cli)[\\/]/i.test(r.commandLine),
    },
    // Gemini CLI (Google). `gemini` binary or node running @google/gemini-cli.
    {
        agent: "gemini",
        test: (r) => /^gemini(\.exe)?$/i.test(r.name) ||
            /@google[\\/]gemini-cli/i.test(r.commandLine) ||
            /[\\/]gemini-cli[\\/]/i.test(r.commandLine),
    },
    // Cursor (the IDE). Cursor.exe is the renderer; child renderer/utility
    // processes also have it as ancestor. Don't match on every Electron
    // descendant — require the literal "Cursor" name to keep false positives
    // down (Code.exe is VS Code, separate signature).
    {
        agent: "cursor",
        test: (r) => /^Cursor(\.exe)?$/i.test(r.name) ||
            /[\\/]Cursor[\\/](?:resources|app|Cursor\.exe)/i.test(r.commandLine),
    },
    // Windsurf (Codeium). Similar to Cursor: it's an Electron-shell IDE.
    {
        agent: "windsurf",
        test: (r) => /^Windsurf(\.exe)?$/i.test(r.name) ||
            /[\\/]Windsurf[\\/](?:resources|app)/i.test(r.commandLine),
    },
    // OpenHands (formerly OpenDevin). Python-based agent.
    {
        agent: "openhands",
        test: (r) => /\bopenhands\b/i.test(r.commandLine),
    },
    // Aider. Python module typically invoked as `python -m aider` or via
    // the `aider` console_script entry point.
    {
        agent: "aider",
        test: (r) => /^aider(\.exe)?$/i.test(r.name) ||
            /[\\/]aider[\\/](?:main|cli|__main__)/i.test(r.commandLine) ||
            /-m\s+aider\b/i.test(r.commandLine),
    },
    // GitHub Copilot CLI / `gh copilot`.
    {
        agent: "copilot",
        test: (r) => /@github[\\/]copilot/i.test(r.commandLine) ||
            /github-copilot-cli/i.test(r.commandLine) ||
            /\bgh\s+copilot\b/i.test(r.commandLine),
    },
];
/**
 * Profile-path keywords. Used as the last-resort heuristic — much weaker
 * than process ancestry but cheap and sometimes the only signal we have
 * (e.g. when the agent process has already exited but Chrome is still up).
 */
const PROFILE_KEYWORDS = [
    "codex",
    "claude",
    "gemini",
    "cursor",
    "windsurf",
    "openhands",
    "aider",
    "copilot",
];
/**
 * Pure inference — takes the already-collected process snapshot and
 * returns a verdict. No I/O, fast enough to run for every external
 * Chrome on the box.
 */
export function inferAgentFromLiveChrome(args, snap) {
    const evidence = [];
    // 1. Walk chrome's parent chain and check each link against signatures.
    if (typeof args.chromePid === "number") {
        const chain = walkParentChain(args.chromePid, snap.processes, 8);
        // Skip chrome itself (chain[0]) so a generic "chrome.exe" doesn't match.
        for (const proc of chain.slice(1)) {
            const hit = matchSignature(proc);
            if (hit) {
                evidence.push(formatEvidence("parent-process", proc));
                return { agent: hit.agent, confidence: "high", evidence };
            }
        }
        // If the chain is just chrome (no parent in the snapshot), the
        // launching process has already exited. Try the persistent birth
        // registry — we may have captured the chain when chrome was new.
        if (chain.length === 1) {
            const me = chain[0];
            const parentDead = me.ppid && me.ppid !== me.pid && !snap.processes.has(me.ppid);
            if (args.births && args.profileDir) {
                const rec = args.births.lookup(args.chromePid, args.profileDir);
                if (rec) {
                    for (const proc of rec.chain.slice(1)) {
                        const recorded = {
                            pid: proc.pid,
                            ppid: proc.ppid,
                            name: proc.name,
                            commandLine: proc.commandLine,
                        };
                        const hit = matchSignature(recorded);
                        if (hit) {
                            evidence.push(`birth-record (${rec.firstSeenAt}): ${formatEvidence("captured-parent", recorded)}`);
                            return { agent: hit.agent, confidence: "high", evidence };
                        }
                    }
                    evidence.push(`birth-record present (captured ${rec.firstSeenAt}) but no agent signature matched`);
                }
            }
            if (parentDead) {
                evidence.push(`parent-process: pid=${me.ppid} already exited (cannot trace ancestry)`);
            }
        }
    }
    // 2. Find peers that hold a TCP-established connection to the debug port.
    //    Then check both the peer itself and its ancestors.
    const peerPids = findCdpPeers(args.port, args.chromePid, snap.connections);
    for (const peerPid of peerPids) {
        const peer = snap.processes.get(peerPid);
        if (!peer)
            continue;
        const hitDirect = matchSignature(peer);
        if (hitDirect) {
            evidence.push(formatEvidence("cdp-peer", peer));
            return { agent: hitDirect.agent, confidence: "high", evidence };
        }
        const peerChain = walkParentChain(peerPid, snap.processes, 8).slice(1);
        for (const ancestor of peerChain) {
            const hit = matchSignature(ancestor);
            if (hit) {
                evidence.push(formatEvidence("cdp-peer-ancestor", ancestor));
                return { agent: hit.agent, confidence: "high", evidence };
            }
        }
    }
    // 3. Profile-path keyword. Lower confidence because the path may have
    //    been chosen by an unrelated tool that happened to use the keyword.
    if (args.profileDir) {
        const lower = args.profileDir.toLowerCase();
        for (const name of PROFILE_KEYWORDS) {
            if (lower.includes(name)) {
                evidence.push(`profile-path: contains "${name}" (${truncate(args.profileDir, 100)})`);
                return { agent: name, confidence: "medium", evidence };
            }
        }
    }
    return { agent: "external", confidence: "none", evidence };
}
/** Walk pid → parent → grandparent → … up to maxDepth or until a cycle. */
export function walkParentChain(pid, processes, maxDepth) {
    const chain = [];
    const seen = new Set();
    let current = processes.get(pid);
    let depth = 0;
    while (current && depth < maxDepth && !seen.has(current.pid)) {
        seen.add(current.pid);
        chain.push(current);
        if (!current.ppid || current.ppid === current.pid)
            break;
        current = processes.get(current.ppid);
        depth++;
    }
    return chain;
}
/**
 * Return PIDs that hold an established TCP connection whose REMOTE port is
 * the chrome debug port — i.e. the client side of the WebSocket. Excludes
 * chrome itself and any connection without an owning PID.
 */
export function findCdpPeers(port, chromePid, connections) {
    const out = new Set();
    for (const c of connections) {
        if (c.remotePort !== port)
            continue;
        if (c.owningPid <= 0)
            continue;
        if (chromePid !== undefined && c.owningPid === chromePid)
            continue;
        out.add(c.owningPid);
    }
    return [...out];
}
/** First matching signature, or null. */
function matchSignature(rec) {
    for (const sig of SIGNATURES) {
        if (sig.test(rec))
            return sig;
    }
    return null;
}
function formatEvidence(source, rec) {
    const cmd = truncate(rec.commandLine || rec.name, 140);
    return `${source}: pid=${rec.pid} ${rec.name} ${cmd}`;
}
function truncate(s, n) {
    if (!s)
        return "";
    return s.length <= n ? s : s.slice(0, n) + "…";
}
