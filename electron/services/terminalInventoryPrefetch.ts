import type { BackendTerminalInfo } from "../../shared/types/ipc.js";
import type { PtyClient } from "./PtyClient.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import { logInfo } from "../utils/logger.js";

/**
 * Cold-switch prefetch of a project's backend terminal inventory.
 *
 * A cold view asks `terminal:get-for-project` only once React has booted,
 * ~240 ms after the switch reached main, and then waits ~100 ms for the
 * pty-host to answer (one `get-project-terminals` request) before it
 * can restore a single pane. Main knows the target the instant the switch
 * arrives, so it starts that fetch right away and the handler consumes the
 * in-flight result instead of paying the round trip on the critical path.
 *
 * Consume-once with a short TTL: the inventory is a snapshot and a terminal
 * can exit between prefetch and hydrate, so a stale answer must never outlive
 * the switch it was taken for. A rejected prefetch is dropped so the handler
 * falls back to a live fetch. A switch whose swap fails, or whose view never
 * hydrates, never consumes its entry, so one shared timer evicts entries as
 * they expire (#17793). An entry expires when either clock says the TTL has
 * passed: the monotonic one paces the sweep and ignores a wall-clock jump
 * backward, and the wall one catches a system sleep, which the monotonic clock
 * does not count.
 */
const PREFETCH_TTL_MS = 5_000;

interface Entry {
  promise: Promise<BackendTerminalInfo[]>;
  /** Monotonic deadline; the sweep is armed on it. */
  expiresAt: number;
  wallExpiresAt: number;
}

const inflight = new Map<string, Entry>();
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function now(): number {
  return performance.now();
}

function isExpired(entry: Entry, at = now()): boolean {
  return entry.expiresAt <= at || entry.wallExpiresAt <= Date.now();
}

function scheduleSweep(): void {
  // Every new entry expires no earlier than the ones already here, so a
  // pending sweep is already due first.
  if (sweepTimer !== null) return;
  let next = Infinity;
  for (const entry of inflight.values()) next = Math.min(next, entry.expiresAt);
  if (next === Infinity) return;
  sweepTimer = setTimeout(sweepExpired, Math.max(0, next - now()));
  sweepTimer.unref?.();
}

function sweepExpired(): void {
  sweepTimer = null;
  const at = now();
  for (const [projectId, entry] of inflight) {
    if (isExpired(entry, at)) inflight.delete(projectId);
  }
  scheduleSweep();
}

function stopSweepIfIdle(): void {
  if (inflight.size > 0 || sweepTimer === null) return;
  clearTimeout(sweepTimer);
  sweepTimer = null;
}

type InventoryPtyClient = Pick<PtyClient, "getProjectTerminalsAsync">;

/** The inventory `terminal:get-for-project` returns, minus panes hydration must never rebuild. */
export async function buildTerminalInventory(
  ptyClient: InventoryPtyClient,
  projectId: string
): Promise<BackendTerminalInfo[]> {
  // One request for every record, in the host's id order (#17776).
  const infos = await ptyClient.getProjectTerminalsAsync(projectId);

  const terminals: BackendTerminalInfo[] = [];
  for (const terminal of infos) {
    // Dev preview and assistant PTYs should not be rehydrated as generic
    // terminal panels during project switching/hydration. The assistant's
    // terminal never has a saved panel, so anything left in this inventory is
    // appended by `restorePanelsPhase` as a grid orphan (#12183) — which is
    // how a renderer crash could surface the assistant's conversation as a
    // pane in the main area.
    if (terminal.kind !== "dev-preview" && !isAssistantTerminalRecord(terminal)) {
      terminals.push({
        id: terminal.id,
        projectId: terminal.projectId,
        kind: terminal.kind,
        launchAgentId: terminal.launchAgentId,
        title: terminal.title,
        titleMode: terminal.titleMode,
        cwd: terminal.cwd,
        // Restore builds each pane's xterm on this grid instead of 80×24,
        // so a reconnected pane never parses its live PTY at the wrong
        // width (#11718).
        ptyCols: terminal.ptyCols,
        ptyRows: terminal.ptyRows,
        agentState: terminal.agentState,
        waitingReason: terminal.waitingReason,
        approvalKind: terminal.approvalKind,
        lastStateChange: terminal.lastStateChange,
        spawnedAt: terminal.spawnedAt,
        isTrashed: terminal.isTrashed,
        trashExpiresAt: terminal.trashExpiresAt,
        activityTier: terminal.activityTier,
        hasPty: terminal.hasPty,
        agentSessionId: terminal.agentSessionId,
        agentLaunchFlags: terminal.agentLaunchFlags,
        agentModelId: terminal.agentModelId,
        agentPresetId: terminal.agentPresetId,
        agentPresetColor: terminal.agentPresetColor,
        originalAgentPresetId: terminal.originalAgentPresetId,
        everDetectedAgent: terminal.everDetectedAgent,
        agentIncarnation: terminal.agentIncarnation,
        updateInstalled: terminal.updateInstalled,
        detectedAgentId: terminal.detectedAgentId,
        detectedProcessId: terminal.detectedProcessId,
      });
    }
  }

  logInfo(`terminal:getForProject(${projectId.slice(0, 8)}): found ${terminals.length} terminals`, {
    terminals: terminals.map((t) => ({
      id: t.id.slice(0, 12),
      kind: t.kind,
      projectId: t.projectId?.slice(0, 8),
    })),
  });
  return terminals;
}

export function prefetchTerminalInventory(
  projectId: string,
  build: (projectId: string) => Promise<BackendTerminalInfo[]>
): Promise<BackendTerminalInfo[]> {
  const existing = inflight.get(projectId);
  if (existing && !isExpired(existing)) return existing.promise;

  const entry: Entry = {
    promise: build(projectId),
    expiresAt: now() + PREFETCH_TTL_MS,
    wallExpiresAt: Date.now() + PREFETCH_TTL_MS,
  };
  entry.promise.catch(() => {
    if (inflight.get(projectId) !== entry) return;
    inflight.delete(projectId);
    stopSweepIfIdle();
  });
  inflight.set(projectId, entry);
  scheduleSweep();
  return entry.promise;
}

/** Take the pending inventory for `projectId`, if one is fresh. Consume-once. */
export function consumeTerminalInventoryPrefetch(
  projectId: string
): Promise<BackendTerminalInfo[]> | null {
  const entry = inflight.get(projectId);
  if (!entry) return null;
  inflight.delete(projectId);
  stopSweepIfIdle();
  if (isExpired(entry)) return null;
  return entry.promise;
}

export function invalidateTerminalInventoryPrefetch(projectId?: string): void {
  if (projectId === undefined) inflight.clear();
  else inflight.delete(projectId);
  stopSweepIfIdle();
}

export function _resetTerminalInventoryPrefetchForTests(): void {
  inflight.clear();
  stopSweepIfIdle();
}

export function _pendingTerminalInventoryPrefetchesForTests(): string[] {
  return [...inflight.keys()];
}
