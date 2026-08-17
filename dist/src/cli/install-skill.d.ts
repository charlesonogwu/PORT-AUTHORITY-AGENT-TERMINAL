export type AgentSkillClient = "codex" | "claude";
export declare const MANAGED_SKILL_MARKER = "<!-- managed-by-portpilot:portpilot-skill-v1 -->";
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
export declare function portpilotSkillSourceDir(): string;
export declare function installAgentSkill(client: AgentSkillClient, opts?: InstallAgentSkillOptions): Promise<InstallAgentSkillResult>;
