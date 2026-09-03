import type { BackendTerminalInfo } from "../../shared/types/ipc.js";
import type { PtyClient } from "./PtyClient.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import { logInfo } from "../utils/logger.js";

/**
 * Cold-switch prefetch of a project's backend terminal inventory.
 *
 * A cold view asks `terminal:get-for-project` only once React has booted,
 * ~240 ms after the switch reached main, and then waits ~100 ms for the
 * pty-host to answer (one id list plus one `get-terminal` per id) before it
 * can restore a single pane. Main knows the target the instant the switch
 * arrives, so it starts that fetch right away and the handler consumes the
 * in-flight result instead of paying the round trip on the critical path.
 *
 * Consume-once with a short TTL: the inventory is a snapshot and a terminal
 * can exit between prefetch and hydrate, so a stale answer must never outlive
 * the switch it was taken for. A rejected prefetch is dropped so the handler
 * falls back to a live fetch.
 */
const PREFETCH_TTL_MS = 5_000;

interface Entry {
  promise: Promise<BackendTerminalInfo[]>;
  expiresAt: number;
}

const inflight = new Map<string, Entry>();

type InventoryPtyClient = Pick<PtyClient, "getTerminalsForProjectAsync" | "getTerminalAsync">;

/** The inventory `terminal:get-for-project` returns, minus panes hydration must never rebuild. */
export async function buildTerminalInventory(
  ptyClient: InventoryPtyClient,
  projectId: string
): Promise<BackendTerminalInfo[]> {
  const terminalIds = await ptyClient.getTerminalsForProjectAsync(projectId);
  const infos = await Promise.all(terminalIds.map((id) => ptyClient.getTerminalAsync(id)));

  const terminals: BackendTerminalInfo[] = [];
  for (const terminal of infos) {
    // Dev preview and assistant PTYs should not be rehydrated as generic
    // terminal panels during project switching/hydration. The assistant's
    // terminal never has a saved panel, so anything left in this inventory is
    // appended by `restorePanelsPhase` as a grid orphan (#12183) — which is
    // how a renderer crash could surface the assistant's conversation as a
    // pane in the main area.
    if (terminal && terminal.kind !== "dev-preview" && !isAssistantTerminalRecord(terminal)) {
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
  if (existing && existing.expiresAt > Date.now()) return existing.promise;

  const entry: Entry = {
    promise: build(projectId),
    expiresAt: Date.now() + PREFETCH_TTL_MS,
  };
  entry.promise.catch(() => {
    if (inflight.get(projectId) === entry) inflight.delete(projectId);
  });
  inflight.set(projectId, entry);
  return entry.promise;
}

/** Take the pending inventory for `projectId`, if one is fresh. Consume-once. */
export function consumeTerminalInventoryPrefetch(
  projectId: string
): Promise<BackendTerminalInfo[]> | null {
  const entry = inflight.get(projectId);
  if (!entry) return null;
  inflight.delete(projectId);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.promise;
}

export function invalidateTerminalInventoryPrefetch(projectId?: string): void {
  if (projectId === undefined) {
    inflight.clear();
    return;
  }
  inflight.delete(projectId);
}

export function _resetTerminalInventoryPrefetchForTests(): void {
  inflight.clear();
}
