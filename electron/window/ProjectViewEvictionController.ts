/**
 * LRU + memory-pressure eviction for ProjectViewManager cached views —
 * dead-view reclaim after a crash/OS memory eviction, cache-limit LRU sweeps,
 * and the periodic cached-view memory sampler. Extracted from
 * ProjectViewManager (#11004).
 */

import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { logDebug, logInfo } from "../utils/logger.js";
import { cleanupEntry, sumGuestMemoryKb } from "./ProjectViewLifecycleController.js";
import { hasActiveAgent } from "./ProjectViewAgentStateCache.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { EvictionReason, ViewEntry } from "./ProjectViewManagerTypes.js";
import { readAvailableSystemMemoryMb } from "../utils/systemMemory.js";
import { memoryPressureTarget } from "../utils/cachedProjectViews.js";
import { isSwapPressureConfirmed } from "../services/systemSwapPressure.js";
import {
  isWorkspaceKeepResident,
  recordWorkspaceEviction,
} from "../services/workspaceResidency.js";

/** A view eligible for eviction; the flags beyond the entry are carried into the eviction log line. */
type EvictionCandidate = {
  projectId: string;
  entry: ViewEntry;
  activeAgent: boolean;
  liveAssistantBackend: boolean;
  boundMcpSession: boolean;
  keepResident: boolean;
};

/**
 * Consecutive sampler readings below the warning edge before a pressure pass
 * may destroy anything (#12363). At the sampler's 30s cadence, two means the
 * reading was still low half a minute later — enough to tell a dip from a trend
 * while confirming real pressure inside a minute. A view the user only just left
 * also waits out MIN_PRESSURE_EVICTION_AGE_MS on top of that.
 */
export const PRESSURE_SAMPLES_TO_CONFIRM = 2;

/**
 * How long a view must have sat unused before a soft-band pressure pass may
 * take it (#12363). The view the user just left is the likeliest next switch,
 * so destroying it trades a ~60ms warm reveal for a cold reload exactly while
 * they are moving between projects. Measured from `lastUsed`, the stamp LRU
 * order already sorts on. Five minutes because a minute was shorter than most
 * real returns: a field log put the median gap before switching back at 199s
 * (#12885).
 */
export const MIN_PRESSURE_EVICTION_AGE_MS = 300_000;

/**
 * The same floor for a sampler tick reading below `criticalMb`. Kept short:
 * there the cache is converging on the active view and the assistant floor,
 * and holding a view for five minutes would leave only tier 2's much slower
 * escalation.
 */
export const MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS = 60_000;

/**
 * Consecutive soft-band evictions that failed to move available memory before
 * the sampler stops evicting for the rest of the episode (#12885). A cached
 * renderer's pages are often already compressed or swapped, so destroying one
 * can free next to nothing the OS reports — a field log showed a median change
 * of −39 MB after ~112 MB evictions, while every eviction cost a cold reload.
 */
export const SOFT_PRESSURE_UNPRODUCTIVE_LIMIT = 2;

/**
 * An eviction counts as productive when the next reading's availability rose
 * by at least this much, or by this fraction of the evicted footprint if that
 * is larger. Readings are noisy, so a token gain is not progress.
 */
export const MIN_SOFT_PRESSURE_GAIN_MB = 32;
export const SOFT_PRESSURE_GAIN_FRACTION = 0.25;

/**
 * workingSetSize is the only cross-platform field — privateBytes is
 * Windows-only and reports 0 (not undefined) on macOS/Linux, so a
 * `privateBytes ?? workingSetSize` fallback never fires there and silently
 * logs every view as 0 KB (lesson #8646).
 */
function readProcessMemoryKb(proc: Electron.ProcessMetric): number {
  return proc.memory.workingSetSize;
}

/**
 * Whether destroying `entry` would kill a running Daintree Assistant (#11157).
 *
 * Three conditions, all load-bearing:
 *
 * 1. HelpSessionService has an unrevoked session for the project with a spawned
 *    PTY bound to it.
 * 2. That PTY is still alive. The binding alone is NOT liveness — it survives
 *    an assistant that exits under its own steam (nothing drops it, and the
 *    orphan sweep skips bound sessions), so without this half a quit assistant
 *    would pin its view for the rest of the session. `isTerminalLive` is
 *    PtyClient's main-local spawn registry: written synchronously by `spawn()`
 *    and dropped on both exit and kill, so it is authoritative from the
 *    assistant's first instant — no seed to wait for, and no pty-host snapshot
 *    that a shard timeout could silently truncate.
 * 3. This is the view the session pinned. `revokeByWebContentsId` only kills
 *    the session whose pinned WebContents matches the destroyed view, so a
 *    second window's cached view of the same project kills nothing on eviction
 *    and stays an ordinary LRU candidate.
 *
 * Agent state is deliberately not consulted: the assistant can dispatch a
 * sub-agent or background shell and go idle while that work runs on, which is
 * precisely the case the issue reports losing.
 */
function hasLiveAssistantBackend(
  host: ProjectViewManager,
  projectId: string,
  entry: ViewEntry
): boolean {
  const backends = host.assistantBackendsForProject?.(projectId) ?? [];
  if (backends.length === 0) return false;
  const wc = entry.view.webContents;
  if (wc.isDestroyed()) return false;
  // All three conditions must hold for the SAME lane (#12108): a dead lane
  // must not borrow a live sibling's liveness, and a lane pinned to another
  // window must not protect this view. Checking them per backend rather than
  // across the set is what keeps both from happening.
  return backends.some(
    (backend) =>
      host.isTerminalLive?.(backend.terminalId) === true && wc.id === backend.webContentsId
  );
}

/**
 * Evict a cached view whose renderer is already gone (OS memory eviction or
 * crash) instead of reloading it in the background. Deferred one tick like
 * the reload branches; re-checks state at run time — if the view was
 * activated between the event and this tick, reload instead so the user
 * isn't left on a blank frame.
 */
export function evictDeadView(
  host: ProjectViewManager,
  projectId: string,
  wc: Electron.WebContents,
  trigger: "memory-eviction" | "crash"
): void {
  setImmediate(() => {
    if (host.disposed || host.win.isDestroyed()) return;
    const entry = host.views.get(projectId);
    if (!entry || entry.view.webContents.id !== wc.id) return;
    if (entry.state !== "cached" || projectId === host.activeProjectId) {
      if (!wc.isDestroyed()) wc.reload();
      return;
    }
    logInfo("projectview.eviction", {
      projectId,
      reason: trigger,
      ageMs: Date.now() - entry.lastUsed,
      activeAgent: hasActiveAgent(host, projectId),
    });
    host.evictionTimestamps.set(projectId, Date.now());
    cleanupEntry(host, projectId);
    // After the teardown, because the write is unconditional and the liveness
    // gate lives on the read side: `readWorkspaceBindingState` surfaces the
    // record only while no view is live, so recording first would notify
    // subscribers into a read that still sees this view and swallows the loss
    // (#12313). A bound MCP session learns from this that its route went away
    // and roughly when, which is the difference between a workspace it can wait
    // for and an id that was never right.
    recordWorkspaceEviction(projectId, trigger);
  });
}

/** Returns the number of views actually evicted — 0 means nothing was eligible. */
/**
 * Whether this window can afford to boot one more background renderer, and why
 * not when it can't (#12320).
 *
 * Admission before creation, deliberately, rather than the create-then-evict
 * shape `switchTo` uses. A user switch has to happen whatever the cost, so
 * overshooting the cap for a moment and letting the deferred `evictStaleViews`
 * repair it is the right trade there. A background restore has no such claim:
 * overshooting would mean spawning a renderer only for the LRU sweep to
 * destroy one — possibly the one just restored — which converts a memory
 * budget into renderer churn.
 *
 * Reads the same numbers the eviction pass converges toward: the configured
 * cap, and the pressure ladder's target when a policy and a reading are both
 * available. Deliberately without the assistant allowance (#12885) — that slot
 * is for a project the user just left, not one the previous session left cold
 * — so restore is at most stricter than reclaim and never admits a view the
 * next pass would destroy. The cap counts the
 * active view, so a window at the ceiling reports `"capacity"` rather than
 * evicting a sibling to make room — a project the user is rotating through is
 * worth more than one the previous session left cold.
 */
export function backgroundRestoreCapacity(
  host: ProjectViewManager
): "available" | "capacity" | "pressure" {
  const availableMb = getAvailableMemoryMb();
  const policy = host.memoryPressurePolicy;
  const systemPressure = isSwapPressureConfirmed();
  const { level, targetMax } =
    policy != null && (availableMb != null || systemPressure)
      ? memoryPressureTarget(availableMb ?? Number.NaN, policy, host.maxCachedViews, {
          systemPressure,
        })
      : { level: "none" as const, targetMax: host.maxCachedViews };

  if (host.views.size >= host.maxCachedViews) return "capacity";
  if (host.views.size >= targetMax) return level === "none" ? "capacity" : "pressure";
  return "available";
}

export function evictStaleViews(
  host: ProjectViewManager,
  reason: EvictionReason,
  forcePressure = false,
  sampledAvailableMb?: number,
  systemPressure = false
): number {
  // Override the user-configured cap when system memory is low so we can
  // reclaim Chromium renderers (~100–500 MB each) before the OS hits
  // compressed-RAM throttling. The override is per-pass — `maxCachedViews`
  // is never mutated, so once pressure subsides the user's setting takes
  // effect on the next eviction.
  //
  // The sampler hands over the reading that confirmed the pass, so the pass acts
  // on the figure it counted. A fresh read landing above the warning edge would
  // turn its one-view gradual pass into an unbudgeted trim to the configured cap
  // that skips the minimum age (#12363).
  //
  // `systemPressure` is the sampler's confirmed kernel-plus-swap reading
  // (#13223), handed over for the same reason.
  const availableMb = sampledAvailableMb ?? getAvailableMemoryMb();
  const policy = host.memoryPressurePolicy;
  const { level, targetMax } =
    policy != null && (availableMb != null || systemPressure)
      ? memoryPressureTarget(availableMb ?? Number.NaN, policy, host.maxCachedViews, {
          systemPressure,
        })
      : { level: "none" as const, targetMax: host.maxCachedViews };
  // What put the pass in its band. Availability below `criticalMb` keeps its
  // own name even when swap agrees, so the shorter critical age floor below
  // still answers to it alone.
  const pressureSource: "available-memory" | "kernel-swap" =
    systemPressure && !(policy != null && availableMb != null && availableMb < policy.criticalMb)
      ? "kernel-swap"
      : "available-memory";

  // A one-pass collapse to the active view happens ONLY on the forced tier-2
  // reclaim. It used to also fire whenever `level === "critical"`, which let
  // any caller self-classify from an instantaneous availability reading —
  // including the per-window sampler, whose ungated 30s tick beat
  // ProcessMemoryMonitor's graduated ladder to the punch by 560ms and destroyed
  // a view the cheap tier-1 pass resolved 2.4s later without it (#11477).
  // Critical escalation now belongs to that ladder alone: it is global (the
  // sampler is per-window), counts consecutive pressure polls, holds a
  // cooldown, and excludes itself while a mitigation is in flight — none of
  // which this function can see. It reaches us through `forcePressure`.
  const criticalPressure = forcePressure;
  // Pressure contraction is driven ONLY by the periodic sweep, so the sampler's
  // 30s cadence is the settling interval between steps: each tick destroys one
  // renderer and the next re-reads a genuinely changed availability figure.
  // Admitting it on the switch (`"lru"`) and `"limit-change"` paths as well
  // would shed extra views at an unbounded, user-driven rate and would need a
  // separate cooldown to stay sane — and, before #11477, let an ordinary
  // project switch landing below `criticalMb` collapse the whole cache.
  //
  // Deliberately spans BOTH bands. Below `criticalMb` `targetMax` is 1, so a
  // critical reading still converges the cache to the active view — one
  // renderer per tick rather than all of them at once. Restricting this to the
  // soft band would zero out per-window reclaim at exactly the memory level
  // where it matters most, leaving only tier 2's 3-poll/10-minute escalation.
  const gradualPressure = !criticalPressure && level !== "none" && reason === "pressure";

  // `baseMax` is the settled target this pass converges toward (before the
  // assistant allowance below raises it to `effectiveMax`); `evictionBudget` is
  // how many views it may actually destroy. They are
  // separate because "shed one at a time" has to hold even when the cache sits
  // ABOVE its configured cap (assistant protection, or a paint-gate exclusion
  // deferring a previous pass) — deriving the budget from the cap would let one
  // soft tick destroy several renderers.
  let baseMax: number;
  let evictionBudget: number;
  if (criticalPressure) {
    baseMax = 1;
    evictionBudget = Number.POSITIVE_INFINITY;
  } else if (gradualPressure) {
    baseMax = targetMax;
    evictionBudget = 1;
  } else {
    baseMax = host.maxCachedViews;
    evictionBudget = Number.POSITIVE_INFINITY;
  }
  const effectiveReason: EvictionReason = criticalPressure || gradualPressure ? "pressure" : reason;
  // Kernel-plus-swap pressure keeps the soft band's age floor: it can hold for
  // hours on a machine that runs hot, and the view the user just left is still
  // the likeliest next switch (#13223).
  const minimumAgeMs =
    level === "critical" && pressureSource === "available-memory"
      ? MIN_CRITICAL_PRESSURE_EVICTION_AGE_MS
      : MIN_PRESSURE_EVICTION_AGE_MS;

  if (host.views.size <= baseMax || host.activeProjectId === null) {
    // Nothing is over target, so whatever the last pass reported has ended; a
    // later pass that finds the cache over it again is a new episode.
    host.lastEvictionSkippedLog = null;
    if (criticalPressure || gradualPressure) host.lastPressureOverrideLog = null;
    return 0;
  }

  // Build pid → memory index from the synchronous app.getAppMetrics()
  // snapshot. Joined per-view via `webContents.getOSProcessId()` so the
  // eviction log line can record each evicted view's footprint. Memory size
  // does not drive eviction order — the largest renderer is typically the
  // project the user has been working in, so size-first ordering destroys
  // the most valuable view. Eviction is pure LRU (see #8602).
  const memoryByPid = new Map<number, number>();
  try {
    // Shared TTL snapshot: the eviction log line tolerates a few seconds of
    // staleness, so a pass landing near another sampler's sweep reuses it.
    for (const proc of getAppMetricsSnapshot()) {
      const kb = readProcessMemoryKb(proc);
      if (kb > 0) {
        memoryByPid.set(proc.pid, kb);
      }
    }
  } catch {
    // app.getAppMetrics() throwing is non-fatal — memoryKb is simply omitted
    // from the eviction log line below.
  }
  const memoryFor = (entry: ViewEntry): number => {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return 0;
    const getPid = (wc as { getOSProcessId?: () => number }).getOSProcessId;
    if (typeof getPid !== "function") return 0;
    const pid = getPid.call(wc);
    if (typeof pid !== "number" || pid <= 0) return 0;
    return memoryByPid.get(pid) ?? 0;
  };
  const guestMemoryFor = (entry: ViewEntry): number =>
    entry.view.webContents.isDestroyed()
      ? 0
      : sumGuestMemoryKb(entry.view.webContents, memoryByPid);

  // Outgoing view of an open paint gate is still on-screen and serving as
  // the anti-flash bridge — treat it as non-evictable, same as the active
  // view. Without this, a setCachedViewLimit(1) call landing mid-gate
  // (e.g. an efficiency-profile transition firing during a slow cold
  // start) would evict the outgoing view and expose the unpainted
  // incoming frame, re-creating the exact flash this gate prevents.
  const gateOutgoingProjectId = host.pendingPaintGate?.outgoingProjectId ?? null;
  // The gate resolves on the incoming skeleton signal (or its own hard
  // timeout) while the outgoing view stays attached until the load finishes,
  // so the gate alone under-covers the very case the guard above describes —
  // by up to the full load ceiling (#11459). `pendingColdSwitch` spans the
  // real on-screen window.
  const switchOutgoingProjectId = host.pendingColdSwitch?.outgoingProjectId ?? null;

  // Views an MCP request is currently awaiting (#11790). Excluded outright,
  // like the two bridges above and for the same reason: destroying one does not
  // just cost a reload, it strands an operation nothing can retry — the caller
  // waits out the bridge deadline and every later call on that session fails
  // `SESSION_BINDING_GONE`, since eviction destroys the WebContents the binding
  // resolves to and nothing recreates it.
  //
  // Each individual lease is self-expiring — held by one pending bridge
  // request, capped at 5s (manifest) or 30s (dispatch), released on the
  // response, the deadline and the view's own destruction alike — which is what
  // makes this a bounded lease rather than the unconditional floor a live
  // assistant backend gets. Note the bound is per-lease, not aggregate: a
  // session dispatching back-to-back can keep one view's refcount above zero
  // indefinitely. That is the intended reading of "keep the view alive while a
  // bound session is actually working", but it does mean sustained traffic can
  // hold the cache over its cap, so the skipped-eviction log below reports it.
  // A session that goes quiet holds nothing, which is the property that keeps
  // this from becoming a floor.
  const mcpLeasedProjectIds = new Set<string>();

  const evictable = Array.from(host.views.entries())
    .filter(([id, entry]) => {
      if (
        id === host.activeProjectId ||
        id === gateOutgoingProjectId ||
        id === switchOutgoingProjectId
      ) {
        return false;
      }
      if (host.mcpActivityFor(id, entry.view.webContents).dispatchLease) {
        mcpLeasedProjectIds.add(id);
        return false;
      }
      return true;
    })
    // Oldest lastUsed first — pure LRU. Sequential switchTo calls stamp
    // distinct millisecond timestamps so equal-lastUsed ties don't arise
    // in practice; Array.sort stability handles them deterministically.
    .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);

  // Partition into three tiers, each LRU-ordered internally.
  //
  // Views without active agents go first, then active-agent views — the
  // long-standing soft guard: it keeps memory bounded (each WebContentsView is
  // ~400-500MB) without silently killing agent renderers mid-task, but it does
  // evict them once safe candidates run out.
  //
  // A view with a live assistant backend is a HARD floor (#11157). It is not
  // merely expensive to evict, it is destructive: destroying the view fires
  // `onViewEvicted` → `revokeByWebContentsId` → `gracefulKill`, which kills the
  // assistant's whole PTY process tree, so every sub-agent and background shell
  // it spawned dies with no completion record. Only the transcript's resume id
  // survives. An ordinary grid terminal has no such coupling — its PTY lives in
  // the pty-host and reconnects on switch-back — which is why the floor is
  // scoped to assistant backends and not to `hasActiveAgent()` at large, whose
  // views are safe to evict and whose projects would otherwise pin the cache
  // for no benefit.
  //
  // The floor is unconditional: no pressure level admits these views (#11477).
  // It originally yielded to critical pressure on the theory that losing the
  // assistant beats an OOM, but that trade does not exist. The reclaim is the
  // renderer teardown, and `memoryFor()` below measures exactly that — the
  // assistant's own process is a node-pty child forked inside the pty-host
  // utility process, reachable only by `terminalId` over a MessagePort. It is
  // never a `<webview>` guest and never appears in `app.getAppMetrics()`, so
  // the `gracefulKill` that follows the teardown recovers nothing this pass can
  // measure. Admitting the view bought no memory the ordinary tiers could not,
  // and cost the user every running sub-agent.
  //
  // Cache growth stays bounded by construction: only the single `webContentsId`
  // a live session pinned is protected, HelpSessionService enforces one backend
  // per project, and another window's view of the same project remains an
  // ordinary candidate. The ceiling is the number of assistants actually
  // running — reported below so the over-cap cache is attributable.
  //
  // A view backing a live-but-idle MCP session binding sits between the two
  // (#11790): evicting it breaks the binding with no recovery path, so it
  // outranks an active-agent view — an ordinary grid terminal's PTY lives in
  // the pty-host and reconnects on switch-back, while a destroyed bound view
  // leaves the session `SESSION_BINDING_GONE` until the user reopens that
  // workspace. But it stays in `candidates`, unlike the assistant floor: the
  // issue is explicit that a hard floor is the wrong answer here, because
  // nothing dies with the renderer the way an assistant's process tree does,
  // and enough concurrent bound sessions would otherwise defeat the pressure
  // policy. So it yields under real pressure, just last.
  //
  // A workspace the *user* granted residency (#12313) is the one tier a client
  // cannot give itself, so it outranks the bound-session ordering above. Still
  // not a floor, and deliberately not an exclusion — see the ordering below.
  const safeToEvict: EvictionCandidate[] = [];
  const activeAgentFallback: EvictionCandidate[] = [];
  const boundMcpSessionFallback: EvictionCandidate[] = [];
  const residentGranted: EvictionCandidate[] = [];
  const assistantProtected: EvictionCandidate[] = [];
  for (const [projectId, entry] of evictable) {
    const activeAgent = hasActiveAgent(host, projectId);
    const mcp = host.mcpActivityFor(projectId, entry.view.webContents);
    // `unknown` (the activity callback threw) deprioritizes but never protects:
    // it must not reach the exclusion set above, or one broken callback would
    // pin every cached view straight through critical pressure.
    const boundMcpSession = mcp.liveBinding || mcp.unknown;
    // Read per pass rather than cached: the grant is a live user setting, and
    // this is also the liveness half (#11162) — the preference record is keyed
    // by workspace id and nothing prunes it when a project is deleted, so a
    // stale entry only ever meets this loop for a view that actually exists.
    const keepResident = isWorkspaceKeepResident(projectId);
    const base = { projectId, entry, activeAgent, boundMcpSession, keepResident };
    if (hasLiveAssistantBackend(host, projectId, entry)) {
      assistantProtected.push({ ...base, liveAssistantBackend: true });
    } else if (keepResident) {
      residentGranted.push({ ...base, liveAssistantBackend: false });
    } else if (boundMcpSession) {
      boundMcpSessionFallback.push({ ...base, liveAssistantBackend: false });
    } else if (activeAgent) {
      activeAgentFallback.push({ ...base, liveAssistantBackend: false });
    } else {
      safeToEvict.push({ ...base, liveAssistantBackend: false });
    }
  }

  // Granted workspaces go last, and stay in `candidates` rather than becoming a
  // fourth exclusion.
  //
  // Being last is the whole mechanism, and it is enough: a pass evicts only
  // until the cache is back at `effectiveMax`, so a grant is taken only once
  // every ungranted candidate is gone — which is exactly "keep this one while
  // there is anything else to give up". Rotating through other projects can no
  // longer evict the workspace holding an orchestrator's agents, because those
  // other projects are always the cheaper answer.
  //
  // Reserving slots instead was the obvious design and is strictly worse. Any
  // reservation big enough to be safe (`effectiveMax` minus the active view,
  // the bridges, the leases and the assistant floor) is by construction never
  // reached — the loop always converges before it needs a reserved view — so
  // the arithmetic produces this same ordering with more code. Sized any larger
  // it stops being safe: with a cap of 1, an active view, a live assistant's
  // floor and one grant, a reservation leaves the pass nothing it may evict and
  // pins three views indefinitely, where the plain tier settles at two.
  //
  // Both halves of the issue's ask fall out of staying in `candidates`, with no
  // branch for either. Residency can never carry the cache over `effectiveMax`,
  // because a candidate is always available to take. And it yields at
  // critical pressure for the same reason — a forced reclaim converges on the
  // active view plus the assistant floor, and a grant is not exempt from that,
  // it is merely the last thing surrendered.
  //
  // What the user gets over `boundMcpSessionFallback` is precedence, which is
  // the right shape: that tier is ordering a client earns just by connecting,
  // and this one is ordering the user granted deliberately.
  const candidates = [
    ...safeToEvict,
    ...activeAgentFallback,
    ...boundMcpSessionFallback,
    ...residentGranted,
  ];

  // Assistant-pinned views still count toward the cache, so without an
  // allowance two running assistants plus the active view fill a cap of three
  // and every other project is evicted the moment the user leaves it (#12885).
  // Non-forced passes keep room for one ordinary warm view beside them. Bounded
  // on purpose: it adds at most one renderer over the floor the assistants
  // already impose, and only when they are what fills the cap. A configured
  // (or pressure-stepped) cap of one reserves no ordinary slot, and the forced
  // reclaim still converges on the active view plus the assistant floor.
  //
  // Counted over every non-active view rather than `assistantProtected`, which
  // omits views a bridge or an MCP lease is holding — those still occupy a slot.
  let pinnedAssistantCount = 0;
  if (!criticalPressure) {
    for (const [projectId, entry] of host.views) {
      if (projectId === host.activeProjectId) continue;
      if (hasLiveAssistantBackend(host, projectId, entry)) pinnedAssistantCount++;
    }
  }
  const effectiveMax =
    pinnedAssistantCount > 0
      ? Math.max(baseMax, pinnedAssistantCount + 1 + Math.min(1, baseMax - 1))
      : baseMax;

  let evictedCount = 0;
  let evictedFootprintKb = 0;
  while (host.views.size > effectiveMax && candidates.length > 0 && evictedCount < evictionBudget) {
    const next = candidates[0];
    const ageMs = Date.now() - next.entry.lastUsed;
    // Ends the pass rather than skipping to the next candidate. The queue is
    // tier-ordered, so passing over a young ordinary view would hand its
    // eviction to an older one the tiers deliberately rank as costlier to lose
    // — an agent's, a bound session's, or a workspace the user granted
    // residency. Gradual passes only: the forced reclaim is the OOM escape
    // hatch, and LRU and limit-change passes enforce a cap the user chose.
    if (gradualPressure && ageMs < minimumAgeMs) {
      logInfo("projectview.eviction-deferred", {
        projectId: next.projectId,
        reason: effectiveReason,
        ageMs,
        minimumAgeMs,
      });
      break;
    }
    candidates.shift();
    const { projectId, entry, activeAgent, liveAssistantBackend, boundMcpSession, keepResident } =
      next;
    const memoryKb = memoryFor(entry);
    const guestMemoryKb = guestMemoryFor(entry);
    const ctx: Record<string, unknown> = {
      projectId,
      reason: effectiveReason,
      ageMs,
      activeAgent,
    };
    if (liveAssistantBackend) ctx.liveAssistantBackend = true;
    // Recorded so a bound session going `SESSION_BINDING_GONE` is traceable to
    // the pass that took its view, rather than looking like the binding broke
    // on its own.
    if (boundMcpSession) ctx.boundMcpSession = true;
    // The user granted this workspace residency and it is being evicted anyway
    // — the cap could not hold every grant, or pressure took the slots. Logged
    // so the override is attributable rather than looking like the grant was
    // ignored (#11162).
    if (keepResident) ctx.keepResident = true;
    if (memoryKb > 0) ctx.memoryKb = memoryKb;
    if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
    if (availableMb != null) ctx.memoryAvailableMb = availableMb;
    logInfo("projectview.eviction", ctx);
    host.evictionTimestamps.set(projectId, Date.now());
    cleanupEntry(host, projectId);
    // After the teardown, because the read side is what gates the record on
    // liveness — see `readWorkspaceBindingState` (#12313).
    recordWorkspaceEviction(projectId, effectiveReason);
    evictedCount++;
    evictedFootprintKb += memoryKb + guestMemoryKb;
  }

  // A soft-band sampler eviction is judged by the next reading — see
  // `maybeEvictUnderPressure`. Any other pass supersedes a pending judgement:
  // its own evictions would be credited to, or blamed on, the soft one.
  if (evictedCount > 0) {
    host.pendingSoftPressureEviction =
      gradualPressure && level === "soft" && availableMb != null
        ? { availableMbBefore: availableMb, evictedFootprintMb: evictedFootprintKb / 1024 }
        : null;
  }

  // Logged after the pass rather than before it, so it can say what the pass
  // did — it used to announce an override on every 30s tick and then find every
  // candidate protected (#12517). A pass that evicts always reports. One that
  // evicts nothing reports only when the override itself has changed, so a
  // cache pinned by live assistants logs its episode once, not every tick.
  // `availableMb` is left out of that comparison: it moves on every reading.
  if (criticalPressure || gradualPressure) {
    const override = {
      thresholdMb: policy?.criticalMb ?? null,
      warningThresholdMb: policy?.warningMb ?? null,
      // The sampled band, not the pass's aggressiveness — a forced tier-2
      // reclaim can land at any band, and a sampler tick reading "critical"
      // still sheds gradually. `forced` carries the aggressiveness.
      pressureLevel: level,
      pressureSource,
      forced: criticalPressure,
      configuredMax: host.maxCachedViews,
      effectiveMax,
      evictionBudget: Number.isFinite(evictionBudget) ? evictionBudget : null,
    };
    const signature = JSON.stringify(override);
    if (evictedCount > 0 || signature !== host.lastPressureOverrideLog) {
      host.lastPressureOverrideLog = signature;
      logInfo("projectview.pressure-override", { availableMb, ...override, evictedCount });
    }
  }

  // The cache is deliberately over its cap because protecting a running
  // assistant outranks the limit. Emit it so the extra resident renderers are
  // attributable — otherwise this reads as a leak in the memory logs. Gated on
  // an exhausted queue, or a pass that stopped at the assistant allowance, so a
  // gradual pass that merely spent its one-view budget or deferred on age
  // (ordinary candidates still waiting) isn't misreported as assistant-blocked.
  //
  // Forced passes are included since #11477 made the floor unconditional: a
  // tier-2 reclaim that converges to "active view + protected assistants"
  // rather than the active view alone is now the expected outcome, and it is
  // exactly the case where an unexplained over-cap cache would read as a leak.
  //
  // MCP dispatch leases open the gate too (#11790). A lease is self-expiring
  // per request, but a session dispatching continuously renews one, so a
  // lease-only stall can persist — exactly the case where an over-cap cache
  // would otherwise sit in the logs with nothing explaining it.
  //
  // The assistant allowance opens it as well (#12885): a pass that stopped at
  // the raised target rather than on an empty queue has still left the cache
  // over `baseMax` because of the assistants, so it is reported the same way.
  if (
    host.views.size > baseMax &&
    (candidates.length === 0 || host.views.size <= effectiveMax) &&
    (assistantProtected.length > 0 || pinnedAssistantCount > 0 || mcpLeasedProjectIds.size > 0)
  ) {
    // `overflow` counts views over `baseMax`, the cap before the assistant
    // allowance; `effectiveMax` is the target the pass settled on. The counts
    // beside them say what is holding the cache over, so a reader can tell a
    // pinned assistant (persistent, this pass will never take it) from a
    // paint-gate/cold-switch bridge (temporary, resolves on its own).
    // Deliberately NOT a partition of `overflow` — counted directly rather
    // than derived by subtraction, because with a `baseMax` above 1 the
    // protected views need not all be over the cap,
    // and subtracting would report a bigger protected share than the overflow.
    const transientlyExcludedProjectIds = new Set(
      [gateOutgoingProjectId, switchOutgoingProjectId].filter(
        (id): id is string => id !== null && id !== host.activeProjectId
      )
    );
    const skipped = {
      reason: effectiveReason,
      forced: criticalPressure,
      viewCount: host.views.size,
      baseMax,
      effectiveMax,
      overflow: host.views.size - baseMax,
      protectedCount: assistantProtected.length,
      transientlyExcludedCount: transientlyExcludedProjectIds.size,
      // Reported as its own reason rather than folded into the transient count
      // (#11790). A lease resolves on its own like the two bridges above, but
      // it is excluded BEFORE assistant protection is evaluated, so folding
      // them together would report an assistant-backed view that happens to be
      // mid-dispatch as transient when its floor outlives the call. Kept apart,
      // each count means exactly one thing.
      mcpLeasedCount: mcpLeasedProjectIds.size,
      protectedProjectIds: assistantProtected.map(({ projectId }) => projectId),
    };
    // Once per change in what is holding the cache over, not once per pass: a
    // live assistant pins its view for as long as it runs, and the sampler
    // re-finds it every 30s (#12517).
    const signature = JSON.stringify(skipped);
    if (signature !== host.lastEvictionSkippedLog) {
      host.lastEvictionSkippedLog = signature;
      logInfo("projectview.eviction-skipped", skipped);
    }
  } else {
    host.lastEvictionSkippedLog = null;
  }

  return evictedCount;
}

/**
 * Periodic renderer-memory sample for cached (non-active) project views.
 * Silent telemetry only — emits one `projectview.cached-memory` event per
 * cached view per tick so the keep-warm cost is observable without any
 * user-visible behaviour change. Debug level, like ProcessMemoryMonitor's own
 * per-process samples: at info it was the bulk of a diagnostics log — one line
 * per cached view every 30s, per window (#12517). Skips when the cache holds
 * only the active view (or fewer) so a single-project session generates no
 * events.
 */
export function sampleCachedViewMemory(host: ProjectViewManager): void {
  if (host.views.size <= 1) return;
  const activeProjectId = host.activeProjectId;

  const memoryByPid = new Map<number, number>();
  // The GPU process is shared by every view, so it is reported once per tick
  // beside each sample rather than attributed to any one of them.
  let gpuKb = 0;
  try {
    // Shared TTL snapshot — telemetry tolerates staleness; per-window
    // samplers near the 30s aligned sweeps reuse them instead of stacking
    // additional full-process-table scans.
    for (const proc of getAppMetricsSnapshot()) {
      const kb = readProcessMemoryKb(proc);
      if (kb > 0) {
        memoryByPid.set(proc.pid, kb);
      }
      if (proc.type === "GPU") gpuKb += kb;
    }
  } catch {
    // app.getAppMetrics() throwing is non-fatal — skip this tick.
    return;
  }

  for (const [projectId, entry] of host.views) {
    if (projectId === activeProjectId) continue;
    // Per-view try/catch keeps a TOCTOU-killed renderer (or any other
    // per-view glitch) from skipping the rest of the cache in this tick.
    try {
      const wc = entry.view.webContents;
      if (wc.isDestroyed()) continue;
      const getPid = (wc as { getOSProcessId?: () => number }).getOSProcessId;
      if (typeof getPid !== "function") continue;
      const pid = getPid.call(wc);
      if (typeof pid !== "number" || pid <= 0) continue;
      const memoryKb = memoryByPid.get(pid);
      if (typeof memoryKb !== "number" || memoryKb <= 0) continue;
      // Webview guests (browser/dev-preview panels) are separate processes
      // whose footprint the host pid lookup misses entirely — for a
      // dev-preview page the guest is often larger than the host. Reported
      // as a separate component so the keep-warm cost stays decomposable.
      const guestMemoryKb = sumGuestMemoryKb(wc, memoryByPid);
      const ctx: Record<string, unknown> = {
        projectId,
        state: entry.state,
        memoryKb,
        pid,
        gpuKb,
      };
      if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
      logDebug("projectview.cached-memory", ctx);
    } catch {
      // Telemetry only — skip this view and continue with the rest.
    }
  }
}

/**
 * Periodic pressure check, piggybacked on the cached-view memory sampler so
 * the reclaim band has a trigger that doesn't depend on the user switching
 * projects. Without this, a session idling with several cached views
 * (~100–500 MB each) while free RAM drifts into the band reclaims nothing
 * until the next cold-start switch or profile-driven `setCachedViewLimit`
 * call. Delegates to `evictStaleViews`, so the LRU ordering, agent protection,
 * and paint-gate exclusions all apply.
 *
 * The gate opens at the WARNING edge, not the critical one: this is the only
 * path that performs banded contraction, so gating it on `criticalMb` would
 * leave the graduated ladder unreachable (#11469).
 *
 * One reading below that edge destroys nothing; it takes
 * PRESSURE_SAMPLES_TO_CONFIRM consecutive ones (#12363). A reading is one
 * instant of a figure the OS is constantly rebalancing, and acting on the first
 * low one let a machine hovering near the edge shed a renderer on every tick it
 * happened to dip. Once confirmed the streak holds, so sustained pressure still
 * converges a view per tick rather than a view per confirmation. A tick that is
 * not a readable low sample — at or above the edge, unreadable, unarmed, or
 * with nothing cached to take — starts the count over.
 *
 * Each soft-band eviction is judged by the next reading, and once
 * SOFT_PRESSURE_UNPRODUCTIVE_LIMIT in a row freed nothing measurable, soft
 * evictions stop until a reading reaches the warning edge again (#12885).
 * Destroying renderers that free no memory the OS will report only buys cold
 * reloads.
 *
 * Confirmed kernel-plus-swap pressure from `SystemMemoryPressureMonitor` opens
 * the gate too, whatever availability reads, and targets the critical band
 * (#13223). macOS counts file-backed pages as available, so a machine 94% into
 * swap can read comfortably inside the soft band while every renderer stalls on
 * page-ins. Those passes keep the confirmation, the one-view budget and the
 * soft band's minimum age, but not the backoff latch: it judges a pass by
 * availability, which is the figure that failed to show this pressure at all.
 * The kernel's warning level alone never qualifies (#12815).
 *
 * Never escalates to a one-pass collapse, at any band. This sampler is
 * per-window, holds no cooldown of its own beyond that latch, and has no view
 * of whether a cheaper mitigation is already in flight — the combination that let it destroy a
 * live assistant's view 560ms into a tier-1 pass that resolved the pressure
 * without it (#11477). Collapse is `ProcessMemoryMonitor`'s tier 2 alone,
 * which owns all of that state globally and arrives via `forcePressure`.
 */
export function maybeEvictUnderPressure(host: ProjectViewManager): void {
  const policy = host.memoryPressurePolicy;
  if (policy == null) {
    host.pressureSampleStreak = 0;
    host.lastPressureOverrideLog = null;
    host.lastEvictionSkippedLog = null;
    clearSoftPressureBackoff(host);
    return;
  }
  // Pending or accumulated backoff state still needs readings once the cache
  // is down to the active view: to settle the last eviction, and to see the
  // recovery that clears the count, or a later episode would inherit it.
  const needsReading =
    host.views.size > 1 ||
    host.pendingSoftPressureEviction != null ||
    host.softPressureUnproductivePasses > 0 ||
    host.softPressureBackoffLatched;
  const availableMb = needsReading ? getAvailableMemoryMb() : null;
  const swapPressure = host.views.size > 1 && isSwapPressureConfirmed();
  if (availableMb != null && availableMb < policy.warningMb) {
    settleSoftPressureEviction(host, availableMb, policy.warningMb);
  } else {
    if (availableMb == null) {
      // No evidence either way: drop the comparison, keep the verdict so far.
      host.pendingSoftPressureEviction = null;
    } else {
      if (host.softPressureBackoffLatched) {
        logInfo("projectview.pressure-backoff-cleared", {
          availableMb,
          warningThresholdMb: policy.warningMb,
        });
      }
      clearSoftPressureBackoff(host);
    }
    if (!swapPressure) {
      host.pressureSampleStreak = 0;
      // The episode is over; the next one reports afresh even if it looks the same.
      host.lastPressureOverrideLog = null;
      host.lastEvictionSkippedLog = null;
      return;
    }
  }

  if (host.views.size <= 1) {
    host.pressureSampleStreak = 0;
    return;
  }
  host.pressureSampleStreak = Math.min(host.pressureSampleStreak + 1, PRESSURE_SAMPLES_TO_CONFIRM);
  if (host.pressureSampleStreak < PRESSURE_SAMPLES_TO_CONFIRM) return;
  // Held for the rest of a soft episode once evictions stopped helping
  // (#12885). A critical reading is not held back: there the cache converges on
  // the active view whatever the last evictions achieved, and tier 2 — not this
  // latch — decides whether a harder reclaim is worth it.
  if (
    !swapPressure &&
    host.softPressureBackoffLatched &&
    availableMb != null &&
    availableMb >= policy.criticalMb
  ) {
    return;
  }
  evictStaleViews(host, "pressure", false, availableMb ?? undefined, swapPressure);
}

/**
 * Judge the previous soft-band eviction against this reading. Productive when
 * availability rose by a meaningful share of what was destroyed; otherwise it
 * counts toward the latch that holds further soft evictions until a reading
 * reaches the warning edge again.
 */
function settleSoftPressureEviction(
  host: ProjectViewManager,
  availableMb: number,
  warningMb: number
): void {
  const pending = host.pendingSoftPressureEviction;
  if (pending == null) return;
  host.pendingSoftPressureEviction = null;
  const gainMb = availableMb - pending.availableMbBefore;
  const requiredGainMb = Math.max(
    MIN_SOFT_PRESSURE_GAIN_MB,
    pending.evictedFootprintMb * SOFT_PRESSURE_GAIN_FRACTION
  );
  const productive = gainMb >= requiredGainMb;
  host.softPressureUnproductivePasses = productive ? 0 : host.softPressureUnproductivePasses + 1;
  const latch =
    !host.softPressureBackoffLatched &&
    host.softPressureUnproductivePasses >= SOFT_PRESSURE_UNPRODUCTIVE_LIMIT;
  if (latch) host.softPressureBackoffLatched = true;
  logInfo("projectview.pressure-eviction-outcome", {
    outcome: productive ? "productive" : "unproductive",
    availableMbBefore: pending.availableMbBefore,
    availableMb,
    gainMb,
    requiredGainMb,
    evictedFootprintMb: Math.round(pending.evictedFootprintMb),
    unproductivePasses: host.softPressureUnproductivePasses,
  });
  if (latch) {
    logInfo("projectview.pressure-backoff", {
      unproductivePasses: host.softPressureUnproductivePasses,
      availableMb,
      warningThresholdMb: warningMb,
    });
  }
}

/** Forget the soft-pressure backoff — a recovered reading or a new band. */
export function clearSoftPressureBackoff(host: ProjectViewManager): void {
  host.pendingSoftPressureEviction = null;
  host.softPressureUnproductivePasses = 0;
  host.softPressureBackoffLatched = false;
}

/**
 * Read system-wide available memory in MB — see `readSystemMemorySnapshot` for
 * what "available" counts on each platform. Returns null when the Chromium API
 * is unavailable (e.g., under test mocks).
 */
export function getAvailableMemoryMb(): number | null {
  return readAvailableSystemMemoryMb();
}
