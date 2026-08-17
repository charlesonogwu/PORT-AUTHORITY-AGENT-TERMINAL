import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentSkillClient = "codex" | "claude";

export const MANAGED_SKILL_MARKER = "<!-- managed-by-portpilot:portpilot-skill-v1 -->";

export interface InstallAgentSkillOptions {
  homeDir?: string;
  codexHome?: string;
  claudeConfigDir?: string;
  sourceDir?: string;
}

export interface InstallAgentSkillResult {
  client: AgentSkillClient;
  skillDir: string;
  backupPath: string | null;
  action: "installed" | "updated" | "already-installed" | "conflict";
  reason?: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

async function sourceMatchesTarget(sourceDir: string, targetDir: string): Promise<boolean> {
  const sourceFiles = await listFiles(sourceDir);
  const targetFiles = await listFiles(targetDir);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) return false;
  for (const file of sourceFiles) {
    const [source, target] = await Promise.all([
      readIfExists(join(sourceDir, file)),
      readIfExists(join(targetDir, file)),
    ]);
    if (source === null || source !== target) return false;
  }
  return true;
}

async function copySkill(sourceDir: string, targetDir: string): Promise<void> {
  const sourceFiles = await listFiles(sourceDir);
  let targetFiles: string[] = [];
  try {
    targetFiles = await listFiles(targetDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const canonical = new Set(sourceFiles);
  for (const stale of targetFiles) {
    if (!canonical.has(stale)) await unlink(join(targetDir, stale));
  }
  for (const file of sourceFiles) {
    const target = join(targetDir, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceDir, file), target);
  }
}

export function portpilotSkillSourceDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "..", "skills", "portpilot"),
    join(moduleDir, "..", "..", "..", "skills", "portpilot"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
  if (!found) throw new Error(`PortPilot skill asset is missing. Checked: ${candidates.join(", ")}`);
  return found;
}

function skillDirFor(client: AgentSkillClient, opts: InstallAgentSkillOptions): string {
  const home = opts.homeDir ?? homedir();
  if (client === "codex") {
    const codexHome = opts.codexHome ??
      (opts.homeDir ? join(home, ".codex") : process.env.CODEX_HOME) ??
      join(home, ".codex");
    return join(codexHome, "skills", "portpilot");
  }
  if (client === "claude") {
    const claudeHome = opts.claudeConfigDir ??
      (opts.homeDir ? join(home, ".claude") : process.env.CLAUDE_CONFIG_DIR) ??
      join(home, ".claude");
    return join(claudeHome, "skills", "portpilot");
  }
  throw new Error(`unknown skill client: ${client as string}. Supported: codex, claude.`);
}

export async function installAgentSkill(
  client: AgentSkillClient,
  opts: InstallAgentSkillOptions = {},
): Promise<InstallAgentSkillResult> {
  if (client !== "codex" && client !== "claude") {
    throw new Error(`unknown skill client: ${client as string}. Supported: codex, claude.`);
  }

  const sourceDir = opts.sourceDir ?? portpilotSkillSourceDir();
  const skillDir = skillDirFor(client, opts);
  const targetSkill = join(skillDir, "SKILL.md");
  const existing = await readIfExists(targetSkill);

  if (existing !== null && !existing.includes(MANAGED_SKILL_MARKER)) {
    return {
      client,
      skillDir,
      backupPath: null,
      action: "conflict",
      reason: `Existing ${targetSkill} is not managed by PortPilot; it was left unchanged.`,
    };
  }

  if (existing !== null && await sourceMatchesTarget(sourceDir, skillDir)) {
    return { client, skillDir, backupPath: null, action: "already-installed" };
  }

  let backupPath: string | null = null;
  if (existing !== null) {
    backupPath = join(dirname(skillDir), `portpilot.SKILL.md.backup-${timestamp()}`);
    await copyFile(targetSkill, backupPath);
  }

  await mkdir(skillDir, { recursive: true });
  await copySkill(sourceDir, skillDir);
  return {
    client,
    skillDir,
    backupPath,
    action: existing === null ? "installed" : "updated",
  };
}
