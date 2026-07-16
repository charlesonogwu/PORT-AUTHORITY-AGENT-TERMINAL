/**
 * Mirror of the snapshot types served by portpilot's dashboard server.
 * The API definition lives in src/dashboard/snapshot.ts in the parent
 * project — keep these in sync if that file changes.
 */

export type EntrySource = "portpilot" | "external"
export type Confidence = "registered" | "inferred" | "unknown"

export interface CdpTab {
  id: string
  type: string
  title?: string
  url?: string
}

export interface LiveSession {
  key: string
  agent: string
  agentConfidence: Confidence
  project: string
  projectConfidence: Confidence
  cwd?: string
  cwdConfidence: Confidence
  task?: string
  pid: number
  /** macOS process creation identity used to reject stale PID reuse. */
  processStart?: string
  chromeDebugPort: number
  /**
   * "port" — TCP debug port reachable from the dashboard
   * "pipe" — stdio pipe owned by the launching agent (Playwright default)
   */
  debugMode: "port" | "pipe"
  /** Which browser backend this lane runs. Absent/"chrome" is the default. */
  browser?: "chrome" | "firefox" | "edge"
  /** Working-set RAM of this lane's whole browser tree, in MB. Absent when
   *  the snapshot has no memory data (non-Windows). */
  memoryMB?: number
  appPort?: number
  chromeProfileDir: string
  /** True when the profile already holds a login/cookie/localStorage store —
   *  i.e. there is saved browser data the user could choose to erase. */
  hasSavedData?: boolean
  browserVersion?: string
  tabs: CdpTab[]
  primaryTabs: CdpTab[]
  registeredBy: EntrySource | null
  laneId?: string
  cdpError?: string
  /**
   * For sessions NOT registered via portpilot, what we inferred about the
   * agent driving Chrome (process ancestry, CDP peer, profile keyword).
   */
  agentInferenceConfidence?: "high" | "medium" | "low" | "none"
  /** Human-readable evidence — surfaced in the expanded session row. */
  agentInferenceEvidence?: string[]
}

export interface RegistryStatus {
  found: boolean
  total: number
  live: number
  stale: number
  empty: number
  staleEntries: {
    laneId: string
    agent: string
    project: string
    reason: string
  }[]
}

export type ConflictKind =
  | "registry-mismatch-with-live"
  | "duplicate-port-within-tool"

export interface Conflict {
  kind: ConflictKind
  port: number
  message: string
  involvedLaneIds: string[]
}

export interface DashboardSnapshot {
  ok: boolean
  generatedAt: string
  scanSource: "sonar" | "native" | "empty"
  scanErrors: string[]
  home: string
  registryPath: string
  config: {
    maxActiveLanes?: number
    warnAtActiveLanes?: number
    chromeDebugRange?: { start: number; end: number }
    appPortRange?: { start: number; end: number }
  }
  summary: {
    liveSessions: number
    distinctAgents: number
    conflicts: number
  }
  liveSessions: LiveSession[]
  registryHealth: { portpilot: RegistryStatus }
  conflicts: Conflict[]
}

export interface KillResult {
  ok: boolean
  error?: string
  killed?: { pid: number; command?: string; port?: number; profileDir?: string }
  releasedLaneId?: string
}
