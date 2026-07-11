import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  Eraser,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { DashboardSnapshot, LiveSession } from "@/types"
import {
  eraseChrome,
  focusChrome,
  getConfig,
  getSnapshot,
  hideChrome,
  killChrome,
  setDefaultBrowser,
  setHiddenPids,
  unhideChrome,
  type DefaultBrowser,
  type WindowPlacement,
} from "@/api/client"
import { cn } from "@/lib/utils"

// 3-second poll cadence balances "live feel" with subprocess cost. Each
// poll spawns `paat dashboard-snapshot --json` (Node, ~500ms cold start on
// Windows) so 2s was burning ~25-50% of every poll interval on process
// spawn alone. 3s keeps the dashboard feeling current while halving that
// background churn. The poll also auto-pauses when the window is hidden
// (see useSnapshot) so the cost only applies when the user is looking.
const POLL_MS = 3_000
const KILL_CONFIRM_MS = 3_000

/* -------------------------------------------------------------------------- */
/*  Persistent "hide until unhide" state                                       */
/* -------------------------------------------------------------------------- */
/**
 * Hiding a Chrome here is durable. hide_chrome moves the window fully
 * off-screen and leaves it SHOWN there, so it stays invisible even as the
 * driving agent keeps raising it (position is untouched by bringToFront /
 * activation). We remember which sessions are hidden so the per-row button
 * flips to "Unhide" and the poll loop re-parks a window that comes back (e.g.
 * Chrome restarted). State is keyed by a PID-FREE stable key (lane id, else
 * port+profile) and mirrored to localStorage so it survives dashboard restarts.
 */
const HIDDEN_LS_KEY = "portpilot.hiddenSessions.v2"
const ENFORCE_POOL = 4

interface HiddenEntry {
  stableKey: string
  laneId?: string
  port: number
  profileNorm: string
  lastPid: number
  placement?: WindowPlacement | null
  hiddenAt: number
}

type HideTarget = Pick<
  LiveSession,
  "laneId" | "chromeDebugPort" | "chromeProfileDir" | "pid"
>

function normProfile(p?: string): string {
  return (p ?? "").replace(/[\\/]+/g, "/").toLowerCase()
}

/**
 * Stable across Chrome restarts. Keyed by debug-port + profile (NOT laneId):
 * a relaunched Chrome reuses the same --remote-debugging-port + --user-data-dir,
 * so the same lane always resolves to the same key even when its pid (and
 * sometimes its laneId) changes. The allocator guarantees no two live lanes
 * share a debug port, so this is unique.
 */
function stableKeyOf(
  s: Pick<LiveSession, "laneId" | "chromeDebugPort" | "chromeProfileDir">
): string {
  const profile = normProfile(s.chromeProfileDir)
  if (profile) return `pp:${s.chromeDebugPort}:${profile}`
  return `port:${s.chromeDebugPort}`
}

interface HiddenApi {
  map: Map<string, HiddenEntry>
  isHidden: (s: HideTarget) => boolean
  getEntry: (s: HideTarget) => HiddenEntry | undefined
  markHidden: (s: HideTarget, placement?: WindowPlacement | null) => void
  patchEntry: (key: string, patch: Partial<HiddenEntry>) => void
  clearHidden: (s: HideTarget) => void
}

function useHiddenSet(): HiddenApi {
  const [map, setMap] = useState<Map<string, HiddenEntry>>(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_LS_KEY)
      if (!raw) return new Map()
      const arr = JSON.parse(raw) as HiddenEntry[]
      return new Map(
        arr.filter((e) => e && e.stableKey).map((e) => [e.stableKey, e])
      )
    } catch {
      return new Map()
    }
  })

  const persist = useCallback((m: Map<string, HiddenEntry>) => {
    try {
      localStorage.setItem(HIDDEN_LS_KEY, JSON.stringify(Array.from(m.values())))
    } catch {
      /* localStorage unavailable — in-memory state still works this session */
    }
  }, [])

  const isHidden = useCallback((s: HideTarget) => map.has(stableKeyOf(s)), [map])
  const getEntry = useCallback((s: HideTarget) => map.get(stableKeyOf(s)), [map])

  const markHidden = useCallback(
    (s: HideTarget, placement?: WindowPlacement | null) => {
      setMap((prev) => {
        const next = new Map(prev)
        const key = stableKeyOf(s)
        next.set(key, {
          stableKey: key,
          laneId: s.laneId,
          port: s.chromeDebugPort,
          profileNorm: normProfile(s.chromeProfileDir),
          lastPid: s.pid,
          placement: placement ?? prev.get(key)?.placement ?? null,
          hiddenAt: Date.now(),
        })
        persist(next)
        return next
      })
    },
    [persist]
  )

  const patchEntry = useCallback(
    (key: string, patch: Partial<HiddenEntry>) => {
      setMap((prev) => {
        const cur = prev.get(key)
        if (!cur) return prev
        const next = new Map(prev)
        next.set(key, { ...cur, ...patch })
        persist(next)
        return next
      })
    },
    [persist]
  )

  const clearHidden = useCallback(
    (s: HideTarget) => {
      setMap((prev) => {
        const key = stableKeyOf(s)
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        persist(next)
        return next
      })
    },
    [persist]
  )

  return { map, isHidden, getEntry, markHidden, patchEntry, clearHidden }
}

/**
 * Drives the native hide-watcher. The watcher thread in the Rust shell keeps
 * every window of every hidden pid off-screen in real time (~150ms); this hook
 * just keeps it told WHICH pids those are, recomputing whenever the live
 * sessions or the hidden set change:
 *   - On change, push the current hidden pids (live sessions whose stable key is
 *     in the hidden map) to the watcher. This covers Chrome restarts for free:
 *     the relaunched Chrome reuses the same port+profile -> same stable key ->
 *     its new pid lands in the set -> the watcher parks its window.
 *   - When a hidden lane's pid changes (restart), recapture the new window's
 *     placement so a later Unhide restores it correctly.
 * Depending on `hiddenApi.map` (referentially stable until a hide/unhide) means
 * an Unhide removes the pid from the watcher within a render tick, before
 * unhideChrome brings the window on-screen — so the watcher never re-parks the
 * window you just unhid.
 */
function useHideEnforcement(
  snap: DashboardSnapshot | null,
  hiddenApi: HiddenApi
): void {
  const apiRef = useRef(hiddenApi)
  apiRef.current = hiddenApi
  const seenPidForKey = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const api = apiRef.current
    const live = snap?.liveSessions ?? []
    const liveKeys = new Set<string>()
    const hiddenPids: number[] = []
    for (const s of live) {
      const key = stableKeyOf(s)
      liveKeys.add(key)
      const entry = api.map.get(key)
      if (!entry) continue
      hiddenPids.push(s.pid)
      // Chrome restarted for a hidden lane (new pid -> new on-screen window):
      // capture the fresh window's placement so a later Unhide restores right.
      // (The watcher already parks it via the pushed pid set below.)
      if (entry.lastPid !== s.pid && seenPidForKey.current.get(key) !== s.pid) {
        seenPidForKey.current.set(key, s.pid)
        void hideChrome(s.pid)
          .then((res) => {
            if (res.ok) {
              apiRef.current.patchEntry(key, {
                lastPid: s.pid,
                ...(res.placement ? { placement: res.placement } : {}),
              })
            }
          })
          .catch(() => {})
      }
    }
    for (const k of Array.from(seenPidForKey.current.keys())) {
      if (!liveKeys.has(k)) seenPidForKey.current.delete(k)
    }

    // Keep the native watcher's pid set in sync (empty array -> watcher idles).
    void setHiddenPids(hiddenPids).catch(() => {})
  }, [snap, hiddenApi.map])
}

/* -------------------------------------------------------------------------- */
/*  Single-instance: detect when the dashboard is open in another tab/window  */
/* -------------------------------------------------------------------------- */
/**
 * The launcher script already prevents duplicate Chrome --app= windows by
 * focusing an existing one if it finds the matching profile. But if the
 * user types http://127.0.0.1:7321/ into a regular Chrome tab — or opens
 * the URL in two normal tabs — the launcher can't help.
 *
 * Detect that case here: every live tab broadcasts a "hello" on a shared
 * channel and listens for replies. The first tab to claim the lock wins;
 * later tabs render an overlay telling the user it's already open and
 * offering to close themselves (browsers only honour window.close() on
 * windows that JS opened, so this is best-effort — but the messaging
 * still tells the user what's going on).
 */
function useSingleInstance(): { primary: boolean } {
  const [primary, setPrimary] = useState<boolean>(true)
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel("portpilot-dashboard-singleton")
    let isPrimary = true
    const myId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    channel.onmessage = (ev: MessageEvent<{ type: string; from: string }>) => {
      const msg = ev.data
      if (!msg || typeof msg !== "object") return
      if (msg.type === "hello" && msg.from !== myId) {
        // Another tab just woke up. The older tab (us) replies "I'm here"
        // and stays primary; the newcomer demotes itself.
        if (isPrimary) channel.postMessage({ type: "claim", from: myId })
      } else if (msg.type === "claim" && msg.from !== myId) {
        // An older tab claimed the singleton — we're the duplicate.
        isPrimary = false
        setPrimary(false)
      }
    }
    // Announce ourselves. If nobody replies within 250 ms we're primary.
    channel.postMessage({ type: "hello", from: myId })

    return () => {
      try {
        channel.close()
      } catch {
        /* ignore */
      }
    }
  }, [])
  return { primary }
}

function DuplicateTabOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/95 backdrop-blur">
      <div className="mx-6 max-w-md rounded-lg border border-border/60 bg-card p-6 text-center shadow-xl">
        <AlertTriangle className="mx-auto mb-3 size-8 text-amber-400" />
        <h2 className="mb-2 text-base font-semibold">
          Port Pilot is already open
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          You already have the Port Pilot dashboard open in another tab or
          window. Close this duplicate so it only runs once.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // window.close() only works on windows that JS opened, but
            // it's still the cleanest hint we can give the user.
            window.close()
          }}
        >
          Close this tab
        </Button>
        <p className="mt-3 text-[11px] text-muted-foreground/70">
          If the button doesn&apos;t do anything, your browser blocked it — just
          close this tab manually.
        </p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hook: poll /api/snapshot every 2s                                         */
/* -------------------------------------------------------------------------- */
function useSnapshot(intervalMs = POLL_MS) {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  // Keep the previous serialized snapshot in a ref so we can dedupe identical
  // payloads without storing them in state (which would itself cause a re-
  // render). When `paat dashboard-snapshot` returns the same data two polls
  // in a row — common when nothing changed — we skip setSnap entirely.
  const lastSerializedRef = useRef<string>("")

  useEffect(() => {
    let cancelled = false
    let intervalId: number | undefined

    const fetchOnce = async () => {
      try {
        const j = await getSnapshot()
        if (cancelled) return
        // Cheap re-render dedup: stringify-compare against the previous
        // payload. The snapshot is ~3 KB of plain JSON so the cost of
        // JSON.stringify (microseconds) is dwarfed by the cost of a wasted
        // React reconciliation across the lane list. If unchanged, we still
        // clear `error` (server is healthy now) but don't churn the tree.
        const serialized = JSON.stringify(j)
        if (serialized !== lastSerializedRef.current) {
          lastSerializedRef.current = serialized
          setSnap(j)
        }
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError((err as Error).message)
      }
    }

    const startInterval = () => {
      if (intervalId != null) return
      intervalId = window.setInterval(fetchOnce, intervalMs)
    }
    const stopInterval = () => {
      if (intervalId == null) return
      window.clearInterval(intervalId)
      intervalId = undefined
    }

    // Pause polling when the window is hidden (minimized, on another desktop,
    // or the user switched workspaces). Spawning `paat dashboard-snapshot`
    // every few seconds for a window the user can't see is pure CPU/IPC
    // waste and was a real source of the "sluggish on restore" symptom —
    // when the window came back, the WebView2 thread was mid-IPC and the
    // queue of in-flight snapshots had to drain before user interactions
    // could be serviced. WebView2 fires document.visibilitychange on Tauri
    // window minimize/restore the same way browser tabs do.
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopInterval()
      } else {
        // Re-sync immediately on restore so the user doesn't have to wait
        // a full poll cycle to see fresh data, then resume the regular
        // cadence.
        fetchOnce()
        startInterval()
      }
    }

    // Initial fetch + cadence (only if visible — uncommon to mount hidden,
    // but defensive).
    if (!document.hidden) {
      fetchOnce()
      startInterval()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      stopInterval()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [intervalMs, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { snap, error, refresh }
}

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                 */
/* -------------------------------------------------------------------------- */
/** 639 -> "639 MB", 1478 -> "1.4 GB". Amber styling kicks in at >= 1 GB. */
function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

function shortUrl(u?: string) {
  if (!u) return ""
  if (u.length <= 80) return u
  return `${u.slice(0, 60)}…${u.slice(-15)}`
}

/* -------------------------------------------------------------------------- */
/*  Header                                                                    */
/* -------------------------------------------------------------------------- */
function Header({ snap }: { snap: DashboardSnapshot | null }) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-card px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <span className="text-base font-semibold tracking-tight">
          Port Pilot
        </span>
      </div>
      <div className="flex items-center gap-7 text-xs text-muted-foreground">
        <Stat label="live" value={snap?.summary.liveSessions ?? 0} />
        <Stat
          label="conflicts"
          value={snap?.summary.conflicts ?? 0}
          tone={(snap?.summary.conflicts ?? 0) > 0 ? "destructive" : undefined}
        />
      </div>
    </header>
  )
}
function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: "destructive"
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className={cn(
          "text-sm font-semibold text-foreground tabular-nums",
          tone === "destructive" && "text-destructive"
        )}
      >
        {value}
      </span>
      <span>{label}</span>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/*  Conflicts banner                                                          */
/* -------------------------------------------------------------------------- */
function ConflictsBanner({ snap }: { snap: DashboardSnapshot }) {
  if (snap.conflicts.length === 0) return null
  return (
    <Alert variant="destructive" className="mb-6">
      <AlertTriangle className="size-4" />
      <AlertTitle>
        {snap.conflicts.length} conflict{snap.conflicts.length > 1 ? "s" : ""}
      </AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-foreground/90">
          {snap.conflicts.slice(0, 6).map((c, i) => (
            <li key={i}>{c.message}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/* -------------------------------------------------------------------------- */
/*  Live sessions table — grouped by cwd                                      */
/* -------------------------------------------------------------------------- */
type GroupedSessions = {
  cwd: string
  project: string
  sessions: LiveSession[]
}[]

function groupByCwd(sessions: LiveSession[]): GroupedSessions {
  const buckets = new Map<
    string,
    { project: string; sessions: LiveSession[] }
  >()
  for (const s of sessions) {
    const key = (s.cwd ?? "(unknown)").toLowerCase()
    const proj = s.project || "(unknown)"
    const b = buckets.get(key) ?? { project: proj, sessions: [] }
    b.sessions.push(s)
    buckets.set(key, b)
  }
  // Sort each group internally and the groups themselves
  for (const v of buckets.values()) {
    v.sessions.sort((a, b) => {
      if (a.agent !== b.agent) return a.agent.localeCompare(b.agent)
      return a.chromeDebugPort - b.chromeDebugPort
    })
  }
  const sorted = Array.from(buckets.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  )
  return sorted.map(([cwd, v]) => ({
    cwd:
      cwd === "(unknown)" ? "(unknown directory)" : (v.sessions[0]?.cwd ?? cwd),
    project: v.project,
    sessions: v.sessions,
  }))
}

function LiveSessions({
  snap,
  onKilled,
  hiddenApi,
}: {
  snap: DashboardSnapshot
  onKilled: () => void
  hiddenApi: HiddenApi
}) {
  const groups = useMemo(
    () => groupByCwd(snap.liveSessions),
    [snap.liveSessions]
  )

  if (snap.liveSessions.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          <Activity className="mx-auto mb-2 size-6 text-muted-foreground/40" />
          No live Chrome sessions.
          <div className="mt-1 text-xs">
            Waiting for an agent to launch Chrome with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
              --remote-debugging-port
            </code>
            .
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[160px]">Agent</TableHead>
            <TableHead className="w-[180px]">Project</TableHead>
            <TableHead className="w-[110px]">Browser</TableHead>
            <TableHead>Current page</TableHead>
            <TableHead className="w-[120px]">Port / pid</TableHead>
            <TableHead className="w-[80px]">RAM</TableHead>
            <TableHead className="w-[110px]">Source</TableHead>
            <TableHead className="w-[90px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g, gi) => (
            <SessionGroup
              key={gi}
              group={g}
              onKilled={onKilled}
              hiddenApi={hiddenApi}
            />
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function SessionGroup({
  group,
  onKilled,
  hiddenApi,
}: {
  group: GroupedSessions[number]
  onKilled: () => void
  hiddenApi: HiddenApi
}) {
  return (
    <>
      <TableRow className="border-y bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={8} className="py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center">
              <span className="mr-3 font-semibold text-foreground">
                {group.project}
              </span>
              <span className="truncate font-mono text-muted-foreground">
                {group.cwd}
              </span>
              <Badge variant="secondary" className="ml-3 font-normal">
                {group.sessions.length} agent
                {group.sessions.length > 1 ? "s" : ""}
              </Badge>
            </div>
            <div
              className="flex shrink-0 items-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <HideAllButton sessions={group.sessions} hiddenApi={hiddenApi} />
              <KillAllButton sessions={group.sessions} onKilled={onKilled} />
            </div>
          </div>
        </TableCell>
      </TableRow>
      {group.sessions.map((s) => (
        <SessionRow
          key={s.key}
          s={s}
          onKilled={onKilled}
          hiddenApi={hiddenApi}
        />
      ))}
    </>
  )
}

function SessionRow({
  s,
  onKilled,
  hiddenApi,
}: {
  s: LiveSession
  onKilled: () => void
  hiddenApi: HiddenApi
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TableRow
        className={cn("cursor-pointer", s.cdpError && s.browser !== "firefox" && "bg-destructive/5")}
        onClick={() => setOpen((o) => !o)}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <span
              className={cn(
                "font-medium",
                s.agentConfidence !== "registered" &&
                  "text-muted-foreground italic"
              )}
            >
              {s.agent || "?"}
            </span>
            {s.agentConfidence === "inferred" && (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[9px] font-normal uppercase"
              >
                inferred
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell>
          <div className="font-medium">{s.project}</div>
        </TableCell>
        <TableCell>
          <BrowserCell browser={s.browser} />
        </TableCell>
        <TableCell className="max-w-0">
          {s.primaryTabs[0] ? (
            <div className="min-w-0">
              <div className="truncate font-medium">
                {s.primaryTabs[0].title || "(untitled)"}
                {s.primaryTabs.length > 1 && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    +{s.primaryTabs.length - 1} more
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                {shortUrl(s.primaryTabs[0].url)}
              </div>
            </div>
          ) : s.browser === "firefox" ? (
            <div
              className="truncate text-xs text-muted-foreground italic"
              title={s.cdpError ?? undefined}
            >
              Firefox lane — tab list unavailable (BiDi); drive it with the page_* tools
            </div>
          ) : (
            <div
              className="truncate text-xs text-muted-foreground italic"
              title={s.cdpError ?? undefined}
            >
              {s.cdpError ? `CDP error: ${s.cdpError}` : "no open pages"}
            </div>
          )}
        </TableCell>
        <TableCell>
          <div className="font-mono text-sm font-semibold">
            {s.debugMode === "pipe" ? (
              <span
                className="text-amber-400"
                title="Chrome was launched with --remote-debugging-pipe; only the launching agent can read its tabs"
              >
                pipe
              </span>
            ) : (
              <>:{s.chromeDebugPort}</>
            )}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            pid {s.pid}
          </div>
        </TableCell>
        <TableCell>
          {s.memoryMB !== undefined ? (
            <div
              className={cn(
                "font-mono text-sm",
                s.memoryMB >= 1024 && "font-semibold text-amber-500"
              )}
              title="Working-set RAM of this lane's whole browser tree (parent + renderer processes)"
            >
              {formatMB(s.memoryMB)}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">—</div>
          )}
        </TableCell>
        <TableCell>
          <SourcePill session={s} />
          {s.hasSavedData && (
            <div
              className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground"
              title="This session has saved logins, cookies and history stored on disk. Use Erase to wipe it."
            >
              <Database className="size-3" /> saved
            </div>
          )}
        </TableCell>
        <TableCell
          className="text-right"
          onClick={(e) => e.stopPropagation()}
          aria-label="row actions"
        >
          <div className="inline-flex items-center gap-1">
            {/* "Show" (focus) only restores + foregrounds; it can't move a
                hidden window back on-screen, and the watcher would re-park it
                anyway. So once a lane is hidden, the only bring-it-back action
                is "Unhide" — hide the dead button to avoid the confusion. */}
            {!hiddenApi.isHidden(s) && <FocusButton pid={s.pid} />}
            <HideToggleButton s={s} hiddenApi={hiddenApi} />
            <KillButton pid={s.pid} onKilled={onKilled} />
            <EraseButton s={s} onErased={onKilled} />
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={8} className="px-6 py-4">
            <ExpandedRow s={s} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function ExpandedRow({ s }: { s: LiveSession }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-3 text-[12px]">
        <Field label="profile dir" mono value={s.chromeProfileDir} />
        <Field
          label="browser"
          value={`${BROWSER_META[s.browser ?? "chrome"].label} · ${
            s.browser === "firefox" ? "WebDriver BiDi" : "Chrome CDP"
          }`}
        />
        <Field label="browser version" value={s.browserVersion ?? "?"} />
        {s.task && <Field label="task (declared)" value={s.task} />}
        {s.appPort && <Field label="app port" mono value={`:${s.appPort}`} />}
        {s.laneId && <Field label="lane id" mono value={s.laneId} />}
        {s.agentInferenceEvidence && s.agentInferenceEvidence.length > 0 && (
          <div>
            <div className="mb-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              agent inference{" "}
              <Badge
                variant="outline"
                className="ml-1 px-1.5 py-0 text-[9px] font-normal uppercase"
              >
                {s.agentInferenceConfidence ?? "none"}
              </Badge>
            </div>
            <ul className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
              {s.agentInferenceEvidence.map((line, i) => (
                <li key={i} className="break-all">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="space-y-2 text-[12px]">
        <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          all tabs ({s.tabs.length})
        </div>
        {s.tabs.length === 0 ? (
          <div className="text-muted-foreground italic">none</div>
        ) : (
          <ScrollArea className="h-[260px] rounded-md border">
            <div className="space-y-1.5 p-2">
              {s.tabs.map((t) => (
                <div
                  key={t.id}
                  className="rounded border-l-2 border-l-primary bg-card px-2.5 py-1.5"
                >
                  <div className="truncate text-[12px] font-medium text-foreground">
                    {t.title || "(untitled)"}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {t.url || ""}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div className={cn("break-all text-foreground", mono && "font-mono")}>
        {value}
      </div>
    </div>
  )
}

// The three browser backends portpilot can drive, with the distinction the
// user cares about: chrome/edge speak Chrome CDP, firefox speaks WebDriver
// BiDi. Absent browser = chrome (pre-0.3.7 lanes). Shown as a dedicated
// column so it's clear at a glance which browser each lane launched — whether
// the LLM picked it via the MCP `open` call or the user asked for it.
const BROWSER_META: Record<
  "chrome" | "edge" | "firefox",
  { label: string; title: string }
> = {
  chrome: {
    label: "Chrome",
    title: "Google Chrome — driven over Chrome DevTools Protocol (CDP)",
  },
  edge: {
    label: "Edge",
    title: "Microsoft Edge — Chromium, driven over Chrome DevTools Protocol (CDP)",
  },
  firefox: {
    label: "Firefox",
    title: "Firefox — driven over WebDriver BiDi (not Chrome CDP); use the page_* tools",
  },
}

function BrowserCell({ browser }: { browser?: "chrome" | "edge" | "firefox" }) {
  const meta = BROWSER_META[browser ?? "chrome"]
  // Plain label in the standard cell font/color — matches Agent/Project text,
  // no color dot or badge.
  return (
    <div className="font-medium" title={meta.title}>
      {meta.label}
    </div>
  )
}

function SourcePill({ session }: { session: LiveSession }) {
  // Three visual states, not two:
  //   "portpilot" — registered through paat reserve / paat open
  //   "inferred"  — we identified the driving agent via process ancestry,
  //                 CDP-peer, or profile-path keyword
  //   "external"  — truly unknown, no signal available
  if (session.registeredBy === "portpilot") {
    return (
      <Badge className="bg-sky-400/15 text-sky-400 hover:bg-sky-400/20">
        Port Pilot
      </Badge>
    )
  }
  const inferred =
    session.agentInferenceConfidence &&
    session.agentInferenceConfidence !== "none" &&
    session.agent !== "external"
  if (inferred) {
    return (
      <Badge
        className="bg-amber-400/15 text-amber-300 hover:bg-amber-400/20"
        title={`Agent inferred via ${session.agentInferenceConfidence}-confidence signals. Click the row for details.`}
      >
        inferred
      </Badge>
    )
  }
  return (
    <Badge className="bg-violet-400/15 text-violet-300 hover:bg-violet-400/20">
      external
    </Badge>
  )
}

/* -------------------------------------------------------------------------- */
/*  Kill button — click to confirm                                            */
/* -------------------------------------------------------------------------- */
/**
 * Focus button — POST /api/focus to bring this Chrome window to the
 * foreground on the user's desktop. Useful when ten Chromes are open
 * and the user wants to visually inspect one of them without hunting
 * through the taskbar.
 */
function FocusButton({ pid }: { pid: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shownAt, setShownAt] = useState<number | null>(null)

  useEffect(() => {
    if (shownAt === null) return
    const id = window.setTimeout(() => setShownAt(null), 1500)
    return () => window.clearTimeout(id)
  }, [shownAt])

  useEffect(() => {
    if (error === null) return
    const id = window.setTimeout(() => setError(null), 3500)
    return () => window.clearTimeout(id)
  }, [error])

  const onClick = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const data = await focusChrome(pid)
      if (!data.ok) {
        setError(data.error ?? "focus failed")
      } else {
        setShownAt(Date.now())
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [busy, pid])

  if (error) {
    return (
      <span className="text-[10px] text-amber-400" title={error}>
        × {error.slice(0, 30)}
      </span>
    )
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={onClick}
      className="h-7 px-2 text-[11px]"
      title={`Bring Chrome pid ${pid} to the foreground`}
    >
      {busy ? (
        "showing…"
      ) : shownAt !== null ? (
        <span className="text-emerald-400">shown ✓</span>
      ) : (
        <span>Show</span>
      )}
    </Button>
  )
}

/**
 * Hide button — POST /api/hide to minimize this Chrome window. Same
 * effect as clicking the underscore in the title bar. The Chrome
 * process keeps running, but it gets out of the way of whatever you're
 * doing on the desktop.
 */
/**
 * Hide-All button — fires POST /api/hide for every visible session in
 * parallel. Useful when ten agent Chromes pop into your face at once
 * and you just want them gone so you can keep working.
 *
 * No confirmation dialog: hide is fully reversible (Show button or the
 * taskbar icon brings any window back) so the friction-free path wins.
 */
function HideAllButton({
  sessions,
  hiddenApi,
}: {
  sessions: LiveSession[]
  hiddenApi: HiddenApi
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    { kind: "idle" } | { kind: "done"; ok: number; failed: number }
  >({ kind: "idle" })

  useEffect(() => {
    if (result.kind !== "done") return
    const id = window.setTimeout(() => setResult({ kind: "idle" }), 2000)
    return () => window.clearTimeout(id)
  }, [result])

  // Flip to "Unhide all" once every in-scope session is already hidden.
  const allHidden =
    sessions.length > 0 && sessions.every((s) => hiddenApi.isHidden(s))

  const onClick = useCallback(async () => {
    if (busy || sessions.length === 0) return
    setBusy(true)
    setResult({ kind: "idle" })
    const targets = [...sessions]
    let i = 0
    let ok = 0
    const worker = async () => {
      while (i < targets.length) {
        const s = targets[i++]
        try {
          if (allHidden) {
            const entry = hiddenApi.getEntry(s)
            hiddenApi.clearHidden(s)
            const res = await unhideChrome(s.pid, entry?.placement)
            if (res.ok) ok++
          } else {
            const res = await hideChrome(s.pid)
            if (res.ok) {
              hiddenApi.markHidden(s, res.placement)
              ok++
            }
          }
        } catch {
          /* counted as failed below */
        }
      }
    }
    const pool = Math.min(ENFORCE_POOL, targets.length)
    await Promise.all(Array.from({ length: pool }, () => worker()))
    setResult({ kind: "done", ok, failed: targets.length - ok })
    setBusy(false)
  }, [busy, sessions, allHidden, hiddenApi])

  const disabled = busy || sessions.length === 0
  const n = sessions.length

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      className="h-7 px-3 text-[11px]"
      title={
        n === 0
          ? "Nothing to hide"
          : allHidden
            ? `Bring all ${n} hidden Chrome window${n === 1 ? "" : "s"} back on-screen`
            : `Hide all ${n} Chrome window${n === 1 ? "" : "s"} off-screen until you unhide`
      }
    >
      {busy ? (
        `${allHidden ? "Unhiding" : "Hiding"} ${n}…`
      ) : result.kind === "done" ? (
        <span className="text-emerald-400">
          {result.failed === 0
            ? `${result.ok} ${allHidden ? "shown" : "hidden"} ✓`
            : `${result.ok} ok, ${result.failed} failed`}
        </span>
      ) : allHidden ? (
        `Unhide all (${n})`
      ) : (
        `Hide all (${n})`
      )}
    </Button>
  )
}

/**
 * Kill-All button — fires POST /api/kill for every session in parallel,
 * after a two-click confirmation. Kill is irreversible (the Chrome
 * processes are terminated, in-flight CDP sessions die, unsaved
 * application state is gone), so we mirror the per-row KillButton's
 * confirm-then-fire pattern at full-fleet scale. Same 3-second reset
 * window via KILL_CONFIRM_MS keeps the UX consistent.
 *
 * After a successful sweep, calls onKilled() so the dashboard refreshes
 * the snapshot immediately instead of waiting for the next 2s poll.
 */
function KillAllButton({
  sessions,
  onKilled,
}: {
  sessions: LiveSession[]
  onKilled: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    { kind: "idle" } | { kind: "done"; ok: number; failed: number }
  >({ kind: "idle" })
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setConfirming(false)
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => {
    if (result.kind !== "done") return
    const id = window.setTimeout(() => setResult({ kind: "idle" }), 2500)
    return () => window.clearTimeout(id)
  }, [result])

  const onClick = useCallback(async () => {
    if (busy) return
    if (sessions.length === 0) return
    if (!confirming) {
      setConfirming(true)
      timer.current = window.setTimeout(reset, KILL_CONFIRM_MS)
      return
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    setConfirming(false)
    setBusy(true)
    setResult({ kind: "idle" })
    const responses = await Promise.all(
      sessions.map(async (s) => {
        try {
          const data = await killChrome(s.pid)
          return data.ok
        } catch {
          return false
        }
      })
    )
    const ok = responses.filter(Boolean).length
    setResult({ kind: "done", ok, failed: sessions.length - ok })
    setBusy(false)
    onKilled()
  }, [busy, confirming, reset, sessions, onKilled])

  const disabled = busy || sessions.length === 0

  return (
    <Button
      size="sm"
      variant={confirming ? "destructive" : "outline"}
      disabled={disabled}
      onClick={onClick}
      className="h-7 px-3 text-[11px]"
      title={
        sessions.length === 0
          ? "Nothing to kill"
          : confirming
            ? `Click again to terminate all ${sessions.length} Chrome processes`
            : `Terminate all ${sessions.length} Chrome processes (irreversible — click twice)`
      }
    >
      {busy ? (
        `Killing ${sessions.length}…`
      ) : result.kind === "done" ? (
        <span className="text-emerald-400">
          {result.failed === 0
            ? `${result.ok} killed ✓`
            : `${result.ok} killed, ${result.failed} failed`}
        </span>
      ) : confirming ? (
        `Confirm kill ${sessions.length}?`
      ) : (
        `Kill all (${sessions.length})`
      )}
    </Button>
  )
}

/**
 * Hide / Unhide toggle. Hide moves the window off-screen and keeps it there
 * (durable against the agent raising it); the button then flips to "Unhide",
 * which restores the window to exactly where it was. Persistence is tracked in
 * the shared hiddenApi (localStorage-backed, keyed by a pid-free stable key).
 */
function HideToggleButton({
  s,
  hiddenApi,
}: {
  s: LiveSession
  hiddenApi: HiddenApi
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hidden = hiddenApi.isHidden(s)

  useEffect(() => {
    if (error === null) return
    const id = window.setTimeout(() => setError(null), 3500)
    return () => window.clearTimeout(id)
  }, [error])

  const onClick = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (hidden) {
        const entry = hiddenApi.getEntry(s)
        // Clear the persistent flag FIRST, so a concurrent poll tick can't
        // re-park the window we are about to bring back.
        hiddenApi.clearHidden(s)
        const res = await unhideChrome(s.pid, entry?.placement)
        if (!res.ok) setError(res.error ?? "unhide failed")
      } else {
        const res = await hideChrome(s.pid)
        if (!res.ok) setError(res.error ?? "hide failed")
        else hiddenApi.markHidden(s, res.placement)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [busy, hidden, s, hiddenApi])

  if (error) {
    return (
      <span className="text-[10px] text-amber-400" title={error}>
        × {error.slice(0, 30)}
      </span>
    )
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={onClick}
      className={cn("h-7 px-2 text-[11px]", hidden && "text-sky-400")}
      title={
        hidden
          ? "Bring this Chrome back on-screen where it was"
          : "Hide this Chrome and keep it off-screen until you click Unhide — even if the agent keeps raising it"
      }
    >
      {busy ? (
        <span>{hidden ? "unhiding…" : "hiding…"}</span>
      ) : hidden ? (
        <span>Unhide</span>
      ) : (
        <span>Hide</span>
      )}
    </Button>
  )
}

function KillButton({ pid, onKilled }: { pid: number; onKilled: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setConfirming(false)
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const onClick = useCallback(async () => {
    if (busy) return
    if (!confirming) {
      setConfirming(true)
      timer.current = window.setTimeout(reset, KILL_CONFIRM_MS)
      return
    }
    if (timer.current) window.clearTimeout(timer.current)
    setBusy(true)
    setError(null)
    try {
      const data = await killChrome(pid)
      if (!data.ok) {
        setError(data.error ?? "unknown error")
        setBusy(false)
        setConfirming(false)
        return
      }
      onKilled()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
      setConfirming(false)
    }
  }, [busy, confirming, pid, onKilled, reset])

  if (error) {
    return (
      <span className="flex items-center justify-end gap-1 text-[10px] text-destructive">
        <X className="size-3" /> {error.slice(0, 40)}
      </span>
    )
  }

  return (
    <Button
      size="sm"
      variant={confirming ? "destructive" : "ghost"}
      disabled={busy}
      onClick={onClick}
      className="h-7 px-2 text-[11px]"
      title={`Terminate Chrome process pid ${pid}`}
    >
      {busy ? (
        "killing…"
      ) : confirming ? (
        "Confirm kill?"
      ) : (
        <>
          <Trash2 className="size-3" />
          <span className="hidden sm:inline">Kill</span>
        </>
      )}
    </Button>
  )
}

/* -------------------------------------------------------------------------- */
/*  Erase button — closes Chrome AND wipes the saved profile (logins, cookies, */
/*  history), then drops the lane so the row disappears. Two-click confirm     */
/*  because, unlike Kill, this is irreversible login loss. Mirrors KillButton. */
/* -------------------------------------------------------------------------- */
function EraseButton({ s, onErased }: { s: LiveSession; onErased: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setConfirming(false)
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const onClick = useCallback(async () => {
    if (busy) return
    if (!confirming) {
      setConfirming(true)
      timer.current = window.setTimeout(reset, KILL_CONFIRM_MS)
      return
    }
    if (timer.current) window.clearTimeout(timer.current)
    setBusy(true)
    setError(null)
    try {
      const data = await eraseChrome(s.pid, s.chromeProfileDir, s.laneId)
      if (!data.ok) {
        setError(data.error ?? "unknown error")
        setBusy(false)
        setConfirming(false)
        return
      }
      onErased()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
      setConfirming(false)
    }
  }, [busy, confirming, s, onErased, reset])

  if (error) {
    return (
      <span className="flex items-center justify-end gap-1 text-[10px] text-destructive">
        <X className="size-3" /> {error.slice(0, 40)}
      </span>
    )
  }

  return (
    <Button
      size="sm"
      variant={confirming ? "destructive" : "ghost"}
      disabled={busy}
      onClick={onClick}
      className="h-7 px-2 text-[11px]"
      title="Erase this session's saved logins, cookies & history. Closes Chrome and cannot be undone."
    >
      {busy ? (
        "erasing…"
      ) : confirming ? (
        "Erase all data?"
      ) : (
        <>
          <Eraser className="size-3" />
          <span className="hidden sm:inline">Erase</span>
        </>
      )}
    </Button>
  )
}

/* -------------------------------------------------------------------------- */
/*  (Registry health, Settings panel, and Footer were removed by request.)    */
/*  The dashboard now stops at the Live Chrome Sessions table.                */
/* -------------------------------------------------------------------------- */

// Removed components stub left intentionally blank.
/* -------------------------------------------------------------------------- */
/*  App                                                                       */
/* -------------------------------------------------------------------------- */
export function App() {
  const { snap, error, refresh } = useSnapshot()
  const { primary } = useSingleInstance()
  const hiddenApi = useHiddenSet()
  useHideEnforcement(snap, hiddenApi)

  if (!primary) {
    return (
      <div className="dark min-h-svh bg-neutral-950 text-foreground">
        <DuplicateTabOverlay />
      </div>
    )
  }

  return (
    <div className="dark min-h-svh bg-neutral-950 text-foreground">
      <Header snap={snap} />
      <main className="mx-auto max-w-7xl px-6 py-6">
        {error && !snap && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>Could not reach the dashboard server</AlertTitle>
            <AlertDescription className="mt-1 font-mono text-[11px]">
              {error}
            </AlertDescription>
          </Alert>
        )}
        {snap && (
          <>
            <ConflictsBanner snap={snap} />
            <div className="mb-3 flex items-center justify-between">
              <SectionLabel className="mb-0">Live Chrome sessions</SectionLabel>
              <div className="flex items-center gap-2">
                <DefaultBrowserPicker />
                <HideAllButton
                  sessions={snap.liveSessions}
                  hiddenApi={hiddenApi}
                />
                <KillAllButton
                  sessions={snap.liveSessions}
                  onKilled={refresh}
                />
              </div>
            </div>
            <LiveSessions
              snap={snap}
              onKilled={refresh}
              hiddenApi={hiddenApi}
            />
          </>
        )}
        {!snap && !error && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Loading…</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Fetching the first snapshot.
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
/**
 * "Default browser" picker. Decides which browser NEW lanes get when an
 * agent calls PortPilot without naming one (i.e. the user gave no browser
 * instruction). An explicit per-call browser always wins, and lanes that
 * already exist keep the browser they were created with — this only covers
 * the "agent opened PortPilot fresh with no preference" case.
 */
function DefaultBrowserPicker() {
  const [value, setValue] = useState<DefaultBrowser>("chrome")
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    getConfig()
      .then((r) => {
        const b = r.config?.defaultBrowser
        if (b === "chrome" || b === "edge" || b === "firefox") setValue(b)
      })
      .catch(() => {
        /* config unreadable — leave the chrome default */
      })
  }, [])
  const onChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as DefaultBrowser
    const prev = value
    setValue(next)
    setSaving(true)
    try {
      await setDefaultBrowser(next)
    } catch {
      setValue(prev) // write failed — don't lie about what's persisted
    } finally {
      setSaving(false)
    }
  }
  return (
    <label
      className="flex items-center gap-2 text-xs text-muted-foreground"
      title="Browser used when an agent opens a NEW lane without asking for a specific one. An explicit browser in the agent's call always wins; existing lanes keep their browser."
    >
      Default browser
      <select
        value={value}
        onChange={onChange}
        disabled={saving}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs font-medium text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 [&>option]:bg-neutral-900"
      >
        <option value="chrome">Chrome</option>
        <option value="edge">Edge</option>
        <option value="firefox">Firefox</option>
      </select>
    </label>
  )
}

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <h2
      className={cn(
        "mb-3 text-[10px] font-semibold tracking-wider text-muted-foreground/80 uppercase",
        className
      )}
    >
      {children}
    </h2>
  )
}

export default App
