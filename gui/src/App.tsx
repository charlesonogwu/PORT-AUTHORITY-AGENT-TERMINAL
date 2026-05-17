import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
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
import { focusChrome, getSnapshot, hideChrome, killChrome } from "@/api/client"
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
}: {
  snap: DashboardSnapshot
  onKilled: () => void
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
            <TableHead>Current page</TableHead>
            <TableHead className="w-[120px]">Port / pid</TableHead>
            <TableHead className="w-[110px]">Source</TableHead>
            <TableHead className="w-[90px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g, gi) => (
            <SessionGroup key={gi} group={g} onKilled={onKilled} />
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function SessionGroup({
  group,
  onKilled,
}: {
  group: GroupedSessions[number]
  onKilled: () => void
}) {
  return (
    <>
      <TableRow className="border-y bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={6} className="py-2 text-xs">
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
              <HideAllButton sessions={group.sessions} />
              <KillAllButton sessions={group.sessions} onKilled={onKilled} />
            </div>
          </div>
        </TableCell>
      </TableRow>
      {group.sessions.map((s) => (
        <SessionRow key={s.key} s={s} onKilled={onKilled} />
      ))}
    </>
  )
}

function SessionRow({ s, onKilled }: { s: LiveSession; onKilled: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TableRow
        className={cn("cursor-pointer", s.cdpError && "bg-destructive/5")}
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
          ) : (
            <div className="text-xs text-muted-foreground italic">
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
          <SourcePill session={s} />
        </TableCell>
        <TableCell
          className="text-right"
          onClick={(e) => e.stopPropagation()}
          aria-label="row actions"
        >
          <div className="inline-flex items-center gap-1">
            <FocusButton pid={s.pid} />
            <HideButton pid={s.pid} />
            <KillButton pid={s.pid} onKilled={onKilled} />
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={6} className="px-6 py-4">
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
        <Field label="browser" value={s.browserVersion ?? "?"} />
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
function HideAllButton({ sessions }: { sessions: LiveSession[] }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    { kind: "idle" } | { kind: "done"; ok: number; failed: number }
  >({ kind: "idle" })

  useEffect(() => {
    if (result.kind !== "done") return
    const id = window.setTimeout(() => setResult({ kind: "idle" }), 2000)
    return () => window.clearTimeout(id)
  }, [result])

  const onClick = useCallback(async () => {
    if (busy) return
    if (sessions.length === 0) return
    setBusy(true)
    setResult({ kind: "idle" })
    const responses = await Promise.all(
      sessions.map(async (s) => {
        try {
          const data = await hideChrome(s.pid)
          return data.ok
        } catch {
          return false
        }
      })
    )
    const ok = responses.filter(Boolean).length
    setResult({ kind: "done", ok, failed: sessions.length - ok })
    setBusy(false)
  }, [busy, sessions])

  const disabled = busy || sessions.length === 0

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      className="h-7 px-3 text-[11px]"
      title={
        sessions.length === 0
          ? "Nothing to hide"
          : `Minimize all ${sessions.length} Chrome window${sessions.length === 1 ? "" : "s"}`
      }
    >
      {busy ? (
        `Hiding ${sessions.length}…`
      ) : result.kind === "done" ? (
        <span className="text-emerald-400">
          {result.failed === 0
            ? `${result.ok} hidden ✓`
            : `${result.ok} hidden, ${result.failed} failed`}
        </span>
      ) : (
        `Hide all (${sessions.length})`
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

function HideButton({ pid }: { pid: number }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hiddenAt, setHiddenAt] = useState<number | null>(null)

  useEffect(() => {
    if (hiddenAt === null) return
    const id = window.setTimeout(() => setHiddenAt(null), 1500)
    return () => window.clearTimeout(id)
  }, [hiddenAt])

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
      const data = await hideChrome(pid)
      if (!data.ok) {
        setError(data.error ?? "hide failed")
      } else {
        setHiddenAt(Date.now())
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
      title={`Minimize Chrome pid ${pid} (same as the underscore button)`}
    >
      {busy ? (
        "hiding…"
      ) : hiddenAt !== null ? (
        <span className="text-emerald-400">hidden ✓</span>
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
                <HideAllButton sessions={snap.liveSessions} />
                <KillAllButton
                  sessions={snap.liveSessions}
                  onKilled={refresh}
                />
              </div>
            </div>
            <LiveSessions snap={snap} onKilled={refresh} />
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
