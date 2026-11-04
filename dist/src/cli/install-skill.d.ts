export type AgentSkillClient = "codex" | "claude";
export declare const MANAGED_SKILL_MARKER = "<!-- managed-by-portpilot:portpilot-skill-v1 -->";
/**
 * The files PortPilot wrote into a skill folder, with their contents' sha256.
 * Upgrades only ever replace or remove files listed here: anything a user
 * adds to the folder is left alone.
 */
export declare const SKILL_MANIFEST = ".portpilot-skill.json";
export interface InstallAgentSkillOptions {
    homeDir?: string;
    codexHome?: string;
    claudeConfigDir?: string;
    sourceDir?: string;
    /** Where backups go. Defaults to <PortPilot home>/skill-backups/<client>, outside every skills folder. */
    backupRoot?: string;
    /** Skip clients whose app folder (~/.codex, ~/.claude) doesn't exist yet. Used by postinstall. */
    onlyExistingApps?: boolean;
}
export interface InstallAgentSkillResult {
    client: AgentSkillClient;
    skillDir: string;
    backupPath: string | null;
    action: "installed" | "updated" | "already-installed" | "conflict" | "skipped";
    reason?: string;
}
/**
 * A manifest key may only name a file inside the skill folder, written the
 * way PortPilot writes keys. A corrupt or planted manifest must never make an
 * upgrade replace or delete anything else, so absolute paths, drive letters,
 * backslashes and "." or ".." segments are rejected.
 */
export declare function isSafeManifestKey(key: string): boolean;
export declare function portpilotSkillSourceDir(): string;
/** The app folder a client keeps its skills in. A blank env var counts as unset. */
export declare function appDirFor(client: AgentSkillClient, opts?: InstallAgentSkillOptions, env?: NodeJS.ProcessEnv): string;
export declare function skillDirFor(client: AgentSkillClient, opts?: InstallAgentSkillOptions, env?: NodeJS.ProcessEnv): string;
/**
 * Backups live outside every skills folder: Codex and Claude Code load each
 * `skills/<name>/SKILL.md`, so a backup kept next to the skill would load as a
 * second, stale copy of it.
 */
export declare function backupRootFor(client: AgentSkillClient, opts?: InstallAgentSkillOptions): string;
export declare function installAgentSkill(client: AgentSkillClient, opts?: InstallAgentSkillOptions): Promise<InstallAgentSkillResult>;
/** Exposed for tests: the containment rule used before every write and delete. */
export declare function isInsideFolder(root: string, path: string): boolean;
