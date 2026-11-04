import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renameWithRetry } from "../core/lockfile.js";
import { portpilotHome } from "../core/paths.js";
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
/** Leftovers of an interrupted write; never a sign the folder belongs to someone else. */
const TEMP_MARKER = ".portpilot-tmp-";
function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
function isIgnored(relativePath) {
    const name = relativePath.split(/[\\/]/).pop() ?? relativePath;
    return IGNORED_NAMES.has(name.toLowerCase()) || name.includes(TEMP_MARKER);
}
/** Manifest keys always use "/" so a manifest written on one OS reads the same on another. */
function manifestKey(relativePath) {
    return relativePath.split(sep).join("/");
}
/**
 * A manifest key may only name a file inside the skill folder, written the
 * way PortPilot writes keys. A corrupt or planted manifest must never make an
 * upgrade replace or delete anything else, so absolute paths, drive letters,
 * backslashes and "." or ".." segments are rejected.
 */
export function isSafeManifestKey(key) {
    if (!key || key.length > 512)
        return false;
    if (key.includes("\\") || key.includes(":") || key.includes("\0") || key.startsWith("/"))
        return false;
    return key.split("/").every((part) => part !== "" && part !== "." && part !== "..");
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
function isInside(root, path) {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith(sep));
}
/**
 * The real folder `file` will live in must be the skill folder or inside it:
 * a link at or below the portpilot folder must never redirect a write or a
 * delete somewhere else.
 */
async function assertContained(realSkillDir, file) {
    const realParent = await realpath(dirname(file));
    if (!isInside(realSkillDir, realParent)) {
        throw new Error(`refusing to write outside the skill folder: ${file} resolves to ${realParent}`);
    }
}
/** Check the nearest existing ancestor before creating each missing directory. */
async function ensureContainedDirectory(realSkillDir, directory) {
    try {
        const actual = await realpath(directory);
        if (!isInside(realSkillDir, actual)) {
            throw new Error(`refusing to write outside the skill folder: ${directory} resolves to ${actual}`);
        }
        return;
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
    await ensureContainedDirectory(realSkillDir, dirname(directory));
    // No recursive mkdir: a dangling link or a concurrently created directory
    // must not redirect creation of further descendants before validation.
    await mkdir(directory).catch((err) => {
        if (err.code !== "EEXIST")
            throw err;
    });
    await assertContained(realSkillDir, join(directory, "placeholder"));
}
/** Write via a temp file + rename so a reader never sees a half-written file. */
async function writeAtomic(realSkillDir, target, content) {
    await ensureContainedDirectory(realSkillDir, dirname(target));
    await assertContained(realSkillDir, target);
    const temp = `${target}${TEMP_MARKER}${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
        await writeFile(temp, content);
        await renameWithRetry(temp, target);
    }
    finally {
        await rm(temp, { force: true });
    }
}
async function pruneBackups(backupRoot) {
    let entries;
    try {
        entries = await readdir(backupRoot);
    }
    catch {
        return;
    }
    const backups = entries.sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
        await rm(join(backupRoot, old), { recursive: true, force: true });
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
/**
 * Backups live outside every skills folder: Codex and Claude Code load each
 * `skills/<name>/SKILL.md`, so a backup kept next to the skill would load as a
 * second, stale copy of it.
 */
export function backupRootFor(client, opts = {}) {
    if (opts.backupRoot)
        return opts.backupRoot;
    const base = opts.homeDir ? join(opts.homeDir, ".portpilot") : portpilotHome();
    return join(base, "skill-backups", client);
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
    const bundledLower = new Set([...bundle.keys()].map((file) => file.toLowerCase()));
    const previous = ownership.kind === "managed" ? ownership.manifest : null;
    await mkdir(skillDir, { recursive: true });
    const realSkillDir = await realpath(skillDir);
    // Filesystem aliases (notably NTFS 8.3 names) can name a shipped file
    // without sharing its spelling. Never schedule those files for removal.
    const bundledRealPaths = new Set();
    for (const file of [...bundle.keys(), SKILL_MANIFEST]) {
        try {
            bundledRealPaths.add((await realpath(join(skillDir, file))).toLowerCase());
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    const toWrite = [];
    for (const [file, content] of bundle) {
        const current = await readIfExists(join(skillDir, file));
        if (current === null || !current.equals(content))
            toWrite.push(file);
    }
    // Only plain files PortPilot itself recorded can be removed, never one that
    // (ignoring case, as Windows and macOS do) is a file it still ships. A copy
    // without a manifest (older installer, or installed by hand) loses nothing.
    const toRemove = [];
    for (const file of Object.keys(previous?.files ?? {})) {
        if (bundledLower.has(file.toLowerCase()))
            continue;
        const info = await lstat(join(skillDir, file)).catch(() => null);
        if (info?.isFile()) {
            const actual = await realpath(join(skillDir, file)).catch(() => null);
            if (actual && !bundledRealPaths.has(actual.toLowerCase()))
                toRemove.push(file);
        }
    }
    const manifest = {
        version: 1,
        files: Object.fromEntries([...bundle].map(([file, content]) => [file, sha256(content)])),
    };
    if (toWrite.length === 0 && toRemove.length === 0) {
        if (JSON.stringify(previous) !== JSON.stringify(manifest)) {
            await writeAtomic(realSkillDir, join(skillDir, SKILL_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
        }
        return { client, skillDir, backupPath: null, action: "already-installed" };
    }
    // Back up every existing file about to be replaced or removed whose content
    // isn't exactly what PortPilot installed (a user edit, or unknown history).
    let backupPath = null;
    const backupRoot = backupRootFor(client, opts);
    for (const file of [...toRemove, ...toWrite]) {
        const current = await readIfExists(join(skillDir, file));
        if (current === null)
            continue;
        if (previous?.files[file] === sha256(current))
            continue;
        backupPath ??= join(backupRoot, timestamp());
        const target = join(backupPath, file);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(skillDir, file), target);
    }
    // Removals first, so a case-only rename on a case-insensitive disk ends with
    // the new file in place.
    for (const file of toRemove) {
        const path = join(skillDir, file);
        if (!isInside(realSkillDir, await realpath(dirname(path)).catch(() => "")))
            continue; // behind a link: never delete
        await unlink(path).catch((err) => {
            if (err.code !== "ENOENT")
                throw err; // another installer got there first
        });
    }
    for (const file of toWrite)
        await writeAtomic(realSkillDir, join(skillDir, file), bundle.get(file));
    await writeAtomic(realSkillDir, join(skillDir, SKILL_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    if (backupPath)
        await pruneBackups(backupRoot);
    return {
        client,
        skillDir,
        backupPath,
        action: ownership.kind === "absent" ? "installed" : "updated",
    };
}
/** Exposed for tests: the containment rule used before every write and delete. */
export function isInsideFolder(root, path) {
    return isInside(resolve(root), resolve(path));
}
