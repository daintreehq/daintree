/**
 * LRU + memory-pressure eviction for ProjectViewManager cached views —
 * dead-view reclaim after a crash/OS memory eviction, cache-limit LRU sweeps,
 * and the periodic cached-view memory sampler. Extracted from
 * ProjectViewManager (#11004).
 */

import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { logInfo } from "../utils/logger.js";
import { cleanupEntry, sumGuestMemoryKb } from "./ProjectViewLifecycleController.js";
import { hasActiveAgent } from "./ProjectViewAgentStateCache.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { EvictionReason, ViewEntry } from "./ProjectViewManagerTypes.js";
import { readAvailableSystemMemoryMb } from "../utils/systemMemory.js";
import { memoryPressureTarget } from "../utils/cachedProjectViews.js";

/** A view eligible for eviction; the flags beyond the entry are carried into the eviction log line. */
type EvictionCandidate = {
  projectId: string;
  entry: ViewEntry;
  activeAgent: boolean;
  liveAssistantBackend: boolean;
  boundMcpSession: boolean;
};

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
  const backend = host.assistantBackendForProject?.(projectId);
  if (!backend) return false;
  if (host.isTerminalLive?.(backend.terminalId) !== true) return false;
  const wc = entry.view.webContents;
  return !wc.isDestroyed() && wc.id === backend.webContentsId;
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
  });
}

/** Returns the number of views actually evicted — 0 means nothing was eligible. */
export function evictStaleViews(
  host: ProjectViewManager,
  reason: EvictionReason,
  forcePressure = false
): number {
  // Override the user-configured cap when system memory is low so we can
  // reclaim Chromium renderers (~100–500 MB each) before the OS hits
  // compressed-RAM throttling. The override is per-pass — `maxCachedViews`
  // is never mutated, so once pressure subsides the user's setting takes
  // effect on the next eviction.
  const availableMb = getAvailableMemoryMb();
  const policy = host.memoryPressurePolicy;
  const { level, targetMax } =
    policy != null && availableMb != null
      ? memoryPressureTarget(availableMb, policy, host.maxCachedViews)
      : { level: "none" as const, targetMax: host.maxCachedViews };

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

  // `effectiveMax` is the settled target this pass converges toward;
  // `evictionBudget` is how many views it may actually destroy. They are
  // separate because "shed one at a time" has to hold even when the cache sits
  // ABOVE its configured cap (assistant protection, or a paint-gate exclusion
  // deferring a previous pass) — deriving the budget from the cap would let one
  // soft tick destroy several renderers.
  let effectiveMax: number;
  let evictionBudget: number;
  if (criticalPressure) {
    effectiveMax = 1;
    evictionBudget = Number.POSITIVE_INFINITY;
  } else if (gradualPressure) {
    effectiveMax = targetMax;
    evictionBudget = 1;
  } else {
    effectiveMax = host.maxCachedViews;
    evictionBudget = Number.POSITIVE_INFINITY;
  }
  const effectiveReason: EvictionReason = criticalPressure || gradualPressure ? "pressure" : reason;

  if (host.views.size <= effectiveMax) return 0;
  if (host.activeProjectId === null) return 0;

  if (criticalPressure || gradualPressure) {
    logInfo("projectview.pressure-override", {
      availableMb,
      thresholdMb: policy?.criticalMb ?? null,
      warningThresholdMb: policy?.warningMb ?? null,
      // The sampled band, not the pass's aggressiveness — a forced tier-2
      // reclaim can land at any band, and a sampler tick reading "critical"
      // still sheds gradually. `forced` carries the aggressiveness.
      pressureLevel: level,
      forced: criticalPressure,
      configuredMax: host.maxCachedViews,
      effectiveMax,
      evictionBudget: Number.isFinite(evictionBudget) ? evictionBudget : null,
    });
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
  // An absolute exclusion is safe here only because it is self-expiring: each
  // lease is held by one pending bridge request, capped at 5s (manifest) or 30s
  // (dispatch), and released on the response, the deadline, and the view's own
  // destruction alike. That is what makes this a bounded lease rather than the
  // unconditional floor a live assistant backend gets — enough concurrent bound
  // sessions could defeat the pressure policy outright if it were permanent, so
  // "bound but quiet" is deliberately NOT excluded here (see the tiers below).
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
  const safeToEvict: EvictionCandidate[] = [];
  const activeAgentFallback: EvictionCandidate[] = [];
  const boundMcpSessionFallback: EvictionCandidate[] = [];
  const assistantProtected: EvictionCandidate[] = [];
  for (const [projectId, entry] of evictable) {
    const activeAgent = hasActiveAgent(host, projectId);
    const boundMcpSession = host.mcpActivityFor(projectId, entry.view.webContents).liveBinding;
    const base = { projectId, entry, activeAgent, boundMcpSession };
    if (hasLiveAssistantBackend(host, projectId, entry)) {
      assistantProtected.push({ ...base, liveAssistantBackend: true });
    } else if (boundMcpSession) {
      boundMcpSessionFallback.push({ ...base, liveAssistantBackend: false });
    } else if (activeAgent) {
      activeAgentFallback.push({ ...base, liveAssistantBackend: false });
    } else {
      safeToEvict.push({ ...base, liveAssistantBackend: false });
    }
  }

  const candidates = [...safeToEvict, ...activeAgentFallback, ...boundMcpSessionFallback];

  let evictedCount = 0;
  while (host.views.size > effectiveMax && candidates.length > 0 && evictedCount < evictionBudget) {
    const { projectId, entry, activeAgent, liveAssistantBackend, boundMcpSession } =
      candidates.shift()!;
    const ageMs = Date.now() - entry.lastUsed;
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
    if (memoryKb > 0) ctx.memoryKb = memoryKb;
    if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
    if (availableMb != null) ctx.memoryAvailableMb = availableMb;
    logInfo("projectview.eviction", ctx);
    host.evictionTimestamps.set(projectId, Date.now());
    cleanupEntry(host, projectId);
    evictedCount++;
  }

  // The cache is deliberately over its cap because protecting a running
  // assistant outranks the limit. Emit it so the extra resident renderers are
  // attributable — otherwise this reads as a leak in the memory logs. Gated on
  // an exhausted queue so a gradual pass that merely spent its one-view budget
  // (ordinary candidates still waiting) isn't misreported as assistant-blocked.
  //
  // Forced passes are included since #11477 made the floor unconditional: a
  // tier-2 reclaim that converges to "active view + protected assistants"
  // rather than the active view alone is now the expected outcome, and it is
  // exactly the case where an unexplained over-cap cache would read as a leak.
  if (host.views.size > effectiveMax && candidates.length === 0 && assistantProtected.length > 0) {
    // `overflow` counts views over target; the two counts beside it say what is
    // holding them, so a reader can tell a pinned assistant (persistent, this
    // pass will never take it) from a paint-gate/cold-switch bridge (temporary,
    // resolves on its own). Deliberately NOT a partition of `overflow` —
    // counted directly rather than derived by subtraction, because with an
    // `effectiveMax` above 1 the protected views need not all be over the cap,
    // and subtracting would report a bigger protected share than the overflow.
    const transientlyExcludedProjectIds = new Set(
      [gateOutgoingProjectId, switchOutgoingProjectId].filter(
        (id): id is string => id !== null && id !== host.activeProjectId
      )
    );
    // MCP dispatch leases belong with the paint-gate/cold-switch bridges, not
    // with the assistant floor: all three resolve on their own, so a reader
    // seeing them here knows the over-cap cache is temporary (#11790).
    for (const projectId of mcpLeasedProjectIds) transientlyExcludedProjectIds.add(projectId);
    logInfo("projectview.eviction-skipped", {
      reason: effectiveReason,
      forced: criticalPressure,
      viewCount: host.views.size,
      effectiveMax,
      overflow: host.views.size - effectiveMax,
      protectedCount: assistantProtected.length,
      transientlyExcludedCount: transientlyExcludedProjectIds.size,
      protectedProjectIds: assistantProtected.map(({ projectId }) => projectId),
    });
  }

  return evictedCount;
}

/**
 * Periodic renderer-memory sample for cached (non-active) project views.
 * Silent telemetry only — emits one `projectview.cached-memory` event per
 * cached view per tick so the keep-warm cost is observable in logs without
 * any user-visible behaviour change. Skips when the cache holds only the
 * active view (or fewer) so a single-project session generates no events.
 */
export function sampleCachedViewMemory(host: ProjectViewManager): void {
  if (host.views.size <= 1) return;
  const activeProjectId = host.activeProjectId;

  const memoryByPid = new Map<number, number>();
  try {
    // Shared TTL snapshot — telemetry tolerates staleness; per-window
    // samplers near the 30s aligned sweeps reuse them instead of stacking
    // additional full-process-table scans.
    for (const proc of getAppMetricsSnapshot()) {
      const kb = readProcessMemoryKb(proc);
      if (kb > 0) {
        memoryByPid.set(proc.pid, kb);
      }
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
        memoryKb,
        pid,
      };
      if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
      logInfo("projectview.cached-memory", ctx);
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
 * Never escalates to a one-pass collapse, at any band. This sampler is
 * per-window and fires off an instantaneous availability reading with no
 * consecutive-poll count, no cooldown, and no view of whether a cheaper
 * mitigation is already in flight — the combination that let it destroy a
 * live assistant's view 560ms into a tier-1 pass that resolved the pressure
 * without it (#11477). Collapse is `ProcessMemoryMonitor`'s tier 2 alone,
 * which owns all of that state globally and arrives via `forcePressure`.
 */
export function maybeEvictUnderPressure(host: ProjectViewManager): void {
  if (host.views.size <= 1) return;
  const policy = host.memoryPressurePolicy;
  if (policy == null) return;
  const availableMb = getAvailableMemoryMb();
  if (availableMb == null || availableMb >= policy.warningMb) return;
  evictStaleViews(host, "pressure");
}

/**
 * Read system-wide available memory in MB. On macOS, "available" = free +
 * purgeable, because Darwin holds reclaimable pages as purgeable rather
 * than free — using `free` alone would fire false positives on every
 * healthy mac. On Windows/Linux, `free` alone is accurate. Returns null
 * when the Chromium API is unavailable (e.g., under test mocks).
 */
export function getAvailableMemoryMb(): number | null {
  return readAvailableSystemMemoryMb();
}
