import type { PtyHostTerminalSnapshot } from "../../shared/types/pty-host.js";
import type { TerminalSnapshot } from "../services/pty/types.js";

export interface SnapshotProvider {
  getTerminalSnapshot: (id: string) => TerminalSnapshot | null;
}

export function toHostSnapshot(
  provider: SnapshotProvider,
  id: string
): PtyHostTerminalSnapshot | null {
  const snapshot = provider.getTerminalSnapshot(id);
  if (!snapshot) return null;

  return {
    id: snapshot.id,
    lines: snapshot.lines,
    lastInputTime: snapshot.lastInputTime,
    lastOutputTime: snapshot.lastOutputTime,
    lastCheckTime: snapshot.lastCheckTime,
    type: snapshot.type,
    worktreeId: snapshot.worktreeId,
    agentId: snapshot.agentId,
    agentState: snapshot.agentState,
    lastStateChange: snapshot.lastStateChange,
    error: snapshot.error,
    spawnedAt: snapshot.spawnedAt,
  };
}
