import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const MANAGED_SKILL_MARKER = "<!-- managed-by-portpilot:portpilot-skill-v1 -->";
/**
 * The files PortPilot wrote into a skill folder, with their contents' sha256.
 * Upgrades only ever replace or remove files listed here: anything a user
 * adds to the folder is left alone.
 */
export const SKILL_MANIFEST = ".portpilot-skill.json";
/** Old backups beyond this many are pruned, newest kept. */
const KEEP_BACKUPS = 3;
/** OS clutter that neither makes a folder "someone else's" nor counts as a change. */
const IGNORED_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
function isIgnored(relativePath) {
    const name = relativePath.split(/[\\/]/).pop() ?? relativePath;
    return IGNORED_NAMES.has(name.toLowerCase());
}
/** Manifest keys always use "/" so a manifest written on one OS reads the same on another. */
function manifestKey(relativePath) {
    return relativePath.split(sep).join("/");
}
async function readIfExists(path) {
    try {
        return await readFile(path);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
async function listFiles(root, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory())
            files.push(...(await listFiles(root, path)));
        else if (entry.isFile())
            files.push(manifestKey(relative(root, path)));
    }
    return files.sort();
}
/**
 * A manifest key may only name a file inside the skill folder. A corrupt or
 * planted manifest must never make an upgrade replace or delete anything
 * else, so absolute paths, drive letters and ".." segments are rejected.
 */
export function isSafeManifestKey(key) {
    if (!key || key.length > 512)
        return false;
    if (/^[\\/]/.test(key) || /^[a-zA-Z]:/.test(key) || key.includes("\0"))
        return false;
    return key.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}
async function readManifest(skillDir) {
    const raw = await readIfExists(join(skillDir, SKILL_MANIFEST));
    if (raw === null || raw.length > 1024 * 1024)
        return null;
    try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files))
            return null;
        const files = {};
        for (const [key, hash] of Object.entries(parsed.files)) {
            if (isSafeManifestKey(key) && typeof hash === "string")
                files[key] = hash;
        }
        return { version: 1, files };
    }
    catch {
        return null;
    }
}
/** Write via a temp file + rename so a reader never sees a half-written file. */
async function writeAtomic(target, content) {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.portpilot-tmp-${process.pid}`;
    await writeFile(temp, content);
    try {
        await rename(temp, target);
    }
    catch (err) {
        await rm(temp, { force: true });
        throw err;
    }
}
async function pruneBackups(skillsRoot) {
    let entries;
    try {
        entries = await readdir(skillsRoot);
    }
    catch {
        return;
    }
    const backups = entries.filter((name) => name.startsWith("portpilot.backup-")).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
        await rm(join(skillsRoot, old), { recursive: true, force: true });
    }
}
export function portpilotSkillSourceDir() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(moduleDir, "..", "..", "skills", "portpilot"),
        join(moduleDir, "..", "..", "..", "skills", "portpilot"),
    ];
    const found = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
    if (!found)
        throw new Error(`PortPilot skill asset is missing. Checked: ${candidates.join(", ")}`);
    return found;
}
function nonBlank(value) {
    return value && value.trim().length > 0 ? value : undefined;
}
/** The app folder a client keeps its skills in. A blank env var counts as unset. */
export function appDirFor(client, opts = {}, env = process.env) {
    const home = opts.homeDir ?? homedir();
    if (client === "codex") {
        return opts.codexHome ?? (opts.homeDir ? undefined : nonBlank(env.CODEX_HOME)) ?? join(home, ".codex");
    }
    if (client === "claude") {
        return opts.claudeConfigDir ?? (opts.homeDir ? undefined : nonBlank(env.CLAUDE_CONFIG_DIR)) ?? join(home, ".claude");
    }
    throw new Error(`unknown skill client: ${client}. Supported: codex, claude.`);
}
export function skillDirFor(client, opts = {}, env = process.env) {
    return join(appDirFor(client, opts, env), "skills", "portpilot");
}
async function ownershipOf(skillDir) {
    let info;
    try {
        info = await lstat(skillDir);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return { kind: "absent" };
        throw err;
    }
    if (info.isSymbolicLink()) {
        return { kind: "foreign", reason: `${skillDir} is a link (for example to a git checkout); PortPilot never writes through it.` };
    }
    if (!info.isDirectory())
        return { kind: "foreign", reason: `${skillDir} exists and is not a folder.` };
    const skill = await readIfExists(join(skillDir, "SKILL.md"));
    if (skill !== null) {
        return skill.toString("utf8").includes(MANAGED_SKILL_MARKER)
            ? { kind: "managed", manifest: await readManifest(skillDir) }
            : { kind: "foreign", reason: `Existing ${join(skillDir, "SKILL.md")} is not managed by PortPilot; it was left unchanged.` };
    }
    const contents = (await listFiles(skillDir)).filter((file) => !isIgnored(file));
    if (contents.length === 0)
        return { kind: "absent" };
    return {
        kind: "foreign",
        reason: `${skillDir} has files but no PortPilot SKILL.md (it may have been renamed to switch the skill off); it was left unchanged.`,
    };
}
export async function installAgentSkill(client, opts = {}) {
    if (client !== "codex" && client !== "claude") {
        throw new Error(`unknown skill client: ${client}. Supported: codex, claude.`);
    }
    const sourceDir = opts.sourceDir ?? portpilotSkillSourceDir();
    const appDir = appDirFor(client, opts);
    const skillDir = join(appDir, "skills", "portpilot");
    if (opts.onlyExistingApps && !existsSync(appDir)) {
        return { client, skillDir, backupPath: null, action: "skipped", reason: `${appDir} does not exist (app not installed).` };
    }
    const ownership = await ownershipOf(skillDir);
    if (ownership.kind === "foreign") {
        return { client, skillDir, backupPath: null, action: "conflict", reason: ownership.reason };
    }
    const bundle = new Map();
    for (const file of await listFiles(sourceDir)) {
        if (!isIgnored(file) && file !== SKILL_MANIFEST)
            bundle.set(file, await readFile(join(sourceDir, file)));
    }
    const previous = ownership.kind === "managed" ? ownership.manifest : null;
    const toWrite = [];
    for (const [file, content] of bundle) {
        const current = await readIfExists(join(skillDir, file));
        if (current === null || !current.equals(content))
            toWrite.push(file);
    }
    // Only plain files PortPilot itself recorded can be removed. A copy without
    // a manifest (older installer, or installed by hand) loses nothing on upgrade.
    const toRemove = [];
    for (const file of Object.keys(previous?.files ?? {})) {
        if (bundle.has(file))
            continue;
        const info = await lstat(join(skillDir, file)).catch(() => null);
        if (info?.isFile())
            toRemove.push(file);
    }
    const manifest = {
        version: 1,
        files: Object.fromEntries([...bundle].map(([file, content]) => [file, sha256(content)])),
    };
    if (toWrite.length === 0 && toRemove.length === 0) {
        if (JSON.stringify(previous) !== JSON.stringify(manifest)) {
            await writeAtomic(join(skillDir, SKILL_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
        }
        return { client, skillDir, backupPath: null, action: "already-installed" };
    }
    // Back up every existing file about to be replaced or removed whose content
    // isn't exactly what PortPilot installed (a user edit, or unknown history).
    let backupPath = null;
    for (const file of [...toWrite, ...toRemove]) {
        const current = await readIfExists(join(skillDir, file));
        if (current === null)
            continue;
        if (previous?.files[file] === sha256(current))
            continue;
        backupPath ??= join(dirname(skillDir), `portpilot.backup-${timestamp()}`);
        const target = join(backupPath, file);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(skillDir, file), target);
    }
    for (const file of toWrite)
        await writeAtomic(join(skillDir, file), bundle.get(file));
    for (const file of toRemove)
        await unlink(join(skillDir, file));
    await writeAtomic(join(skillDir, SKILL_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    if (backupPath)
        await pruneBackups(dirname(skillDir));
    return {
        client,
        skillDir,
        backupPath,
        action: ownership.kind === "absent" ? "installed" : "updated",
    };
}
