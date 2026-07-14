/**
 * LRU + memory-pressure eviction for ProjectViewManager cached views —
 * dead-view reclaim after a crash/OS memory eviction, cache-limit LRU sweeps,
 * and the periodic cached-view memory sampler. Extracted from
 * ProjectViewManager (#11004).
 */

import { getAppMetricsSnapshot } from "../utils/appMetricsSnapshot.js";
import { logInfo } from "../utils/logger.js";
import { cleanupEntry, sumGuestMemoryKb } from "./ProjectViewLifecycleController.js";
import { hasActiveAgent, hasLiveAssistantBackend } from "./ProjectViewAgentStateCache.js";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { EvictionReason, ViewEntry } from "./ProjectViewManagerTypes.js";
import { readAvailableSystemMemoryMb } from "../utils/systemMemory.js";

/** `[projectId, entry, activeAgent, liveAssistantBackend]` — the last two are carried into the eviction log line. */
type EvictionCandidate = [string, ViewEntry, boolean, boolean];

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

export function evictStaleViews(
  host: ProjectViewManager,
  reason: EvictionReason,
  forcePressure = false
): void {
  // Override the user-configured cap when system memory is low so we can
  // reclaim Chromium renderers (~100–500 MB each) before the OS hits
  // compressed-RAM throttling. The override is per-pass — `maxCachedViews`
  // is never mutated, so once pressure subsides the user's setting takes
  // effect on the next eviction.
  const availableMb = getAvailableMemoryMb();
  const lowMemoryOverride =
    forcePressure ||
    (host.lowMemoryFreeThresholdMb != null &&
      availableMb != null &&
      availableMb < host.lowMemoryFreeThresholdMb);
  const effectiveMax = lowMemoryOverride ? 1 : host.maxCachedViews;
  const effectiveReason: EvictionReason = lowMemoryOverride ? "pressure" : reason;

  if (host.views.size <= effectiveMax) return;
  if (host.activeProjectId === null) return;

  if (lowMemoryOverride) {
    logInfo("projectview.pressure-override", {
      availableMb,
      thresholdMb: host.lowMemoryFreeThresholdMb,
      configuredMax: host.maxCachedViews,
      effectiveMax,
    });
  }

  // Build pid → privateBytes index from the synchronous app.getAppMetrics()
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
      const kb = proc.memory.privateBytes ?? proc.memory.workingSetSize;
      if (typeof kb === "number" && kb > 0) {
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

  const evictable = Array.from(host.views.entries())
    .filter(([id]) => id !== host.activeProjectId && id !== gateOutgoingProjectId)
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
  // A view with a live assistant backend is a HARD floor for routine passes
  // (#11157). It is not merely expensive to evict, it is destructive:
  // destroying the view fires `onViewEvicted` → `revokeByWebContentsId` →
  // `gracefulKill`, which kills the assistant's whole PTY process tree, so
  // every sub-agent and background shell it spawned dies with no completion
  // record. Only the transcript's resume id survives. An ordinary grid terminal
  // has no such coupling — its PTY lives in the pty-host and reconnects on
  // switch-back — which is why the floor is scoped to assistant backends and
  // not to `hasActiveAgent()` at large, whose views are safe to evict and whose
  // projects would otherwise pin the cache for no benefit.
  //
  // The floor yields to genuine memory pressure: `lowMemoryOverride` puts these
  // views back in the pool, but LAST, so every ordinary renderer is reclaimed
  // before an assistant's work is. Losing the assistant beats an OOM, and the
  // hibernation capture on that path still preserves the conversation.
  const safeToEvict: EvictionCandidate[] = [];
  const activeAgentFallback: EvictionCandidate[] = [];
  const assistantProtected: EvictionCandidate[] = [];
  for (const [projectId, entry] of evictable) {
    const active = hasActiveAgent(host, projectId);
    if (hasLiveAssistantBackend(host, projectId)) {
      assistantProtected.push([projectId, entry, active, true]);
    } else if (active) {
      activeAgentFallback.push([projectId, entry, true, false]);
    } else {
      safeToEvict.push([projectId, entry, false, false]);
    }
  }

  const candidates = lowMemoryOverride
    ? [...safeToEvict, ...activeAgentFallback, ...assistantProtected]
    : [...safeToEvict, ...activeAgentFallback];

  while (host.views.size > effectiveMax && candidates.length > 0) {
    const [projectId, entry, activeAgent, liveAssistantBackend] = candidates.shift()!;
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
    if (memoryKb > 0) ctx.memoryKb = memoryKb;
    if (guestMemoryKb > 0) ctx.guestMemoryKb = guestMemoryKb;
    if (availableMb != null) ctx.memoryAvailableMb = availableMb;
    logInfo("projectview.eviction", ctx);
    host.evictionTimestamps.set(projectId, Date.now());
    cleanupEntry(host, projectId);
  }

  // The cache is deliberately over its cap because protecting a running
  // assistant outranks the limit. Emit it so the extra resident renderers are
  // attributable — otherwise this reads as a leak in the memory logs.
  if (!lowMemoryOverride && host.views.size > effectiveMax && assistantProtected.length > 0) {
    logInfo("projectview.eviction-skipped", {
      reason: effectiveReason,
      viewCount: host.views.size,
      effectiveMax,
      overflow: host.views.size - effectiveMax,
      protectedProjectIds: assistantProtected.map(([projectId]) => projectId),
    });
  }
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
      const kb = proc.memory.privateBytes ?? proc.memory.workingSetSize;
      if (typeof kb === "number" && kb > 0) {
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
 * the `lowMemoryFreeThresholdMb` floor has a trigger that doesn't depend on
 * the user switching projects. Without this, a session idling with several
 * cached views (~100–500 MB each) while free RAM drifts below the floor
 * reclaims nothing until the next cold-start switch or profile-driven
 * `setCachedViewLimit` call. Delegates to `evictStaleViews`, so the LRU
 * ordering, agent protection, and paint-gate exclusions all apply.
 */
export function maybeEvictUnderPressure(host: ProjectViewManager): void {
  if (host.views.size <= 1) return;
  if (host.lowMemoryFreeThresholdMb == null) return;
  const availableMb = getAvailableMemoryMb();
  if (availableMb == null || availableMb >= host.lowMemoryFreeThresholdMb) return;
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
