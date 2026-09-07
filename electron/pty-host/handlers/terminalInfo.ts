import { isBuiltInAgentId, type BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { readPtyDimension } from "../../services/pty/TerminalProcess.js";
import type { HostContext } from "./types.js";

type TerminalInfoLike = ReturnType<HostContext["ptyManager"]["getTerminal"]>;

/** Narrow a backend TerminalType-valued detection field to BuiltInAgentId for IPC. */
export function narrowDetectedAgentId(value: unknown): BuiltInAgentId | undefined {
  return isBuiltInAgentId(value) ? value : undefined;
}

/**
 * Single source of truth for the IPC terminal-info payload shape sent in
 * response to query-family messages (`get-terminal`, `get-available-terminals`,
 * `get-terminals-by-state`, `get-all-terminals`).
 *
 * `isTrashed` reads from the registry (`ptyManager.isInTrash(t.id)`) rather
 * than the raw `TerminalInfo.isTrashed` field — that field is not maintained
 * on the in-memory record, so reading it directly always returned undefined
 * (lesson #4753).
 *
 * `ptyCols`/`ptyRows` report the grid the PTY is ACTUALLY on, straight off the
 * node-pty handle. A reconnecting renderer has no other way to learn it — its
 * own xterm is built fresh at 80×24 — and guessing wrong means the pane parses
 * a live wide agent into a narrow grid until something refits it (#11718). Read
 * at request time rather than cached, so it can never go stale.
 *
 * Read through `readPtyDimension` and only for a LIVE handle, the same contract
 * `TerminalProcess.readPtyGeometry` uses: the getter is native and can throw
 * once the pty is torn down, and an uncaught throw here would take out the whole
 * query — `get-terminal` degrades to `null` (the record vanishes from restore),
 * and the batch families lose an entire shard's response. A dead record's last
 * grid is not a live grid either, so it reports unknown and restore falls back.
 */
export function mapTerminalInfo(t: NonNullable<TerminalInfoLike>, ctx: HostContext) {
  const hasPty = !t.wasKilled && !t.isExited;
  const ptyCols = hasPty ? readPtyDimension(() => t.ptyProcess.cols, null) : null;
  const ptyRows = hasPty ? readPtyDimension(() => t.ptyProcess.rows, null) : null;
  return {
    id: t.id,
    projectId: t.projectId,
    kind: t.kind,
    // Null (unknown) is normalised to absent so the field means "the host did
    // not report a grid" on both the old-host and dead-handle paths.
    ptyCols: ptyCols ?? undefined,
    ptyRows: ptyRows ?? undefined,

    launchAgentId: t.launchAgentId,
    isAssistantTerminal: t.isAssistantTerminal,
    title: t.title,
    titleMode: t.titleMode,
    // Preferred over `title` for resume-record labels on the kill/shutdown
    // close paths — without it those records regress to the bare agent name.
    lastObservedTitle: t.lastObservedTitle,
    cwd: t.cwd,
    agentState: t.agentState,
    waitingReason: t.waitingReason,
    lastStateChange: t.lastStateChange,
    lastInputTime: t.lastInputTime,
    lastOutputTime: t.lastOutputTime,
    spawnedAt: t.spawnedAt,
    isTrashed: ctx.ptyManager.isInTrash(t.id),
    trashExpiresAt: t.trashExpiresAt,
    activityTier: ctx.ptyManager.getActivityTier(t.id),
    hasPty,
    agentSessionId: t.agentSessionId,
    agentLaunchFlags: t.agentLaunchFlags,
    agentModelId: t.agentModelId,
    worktreeId: t.worktreeId,
    agentPresetId: t.agentPresetId,
    agentPresetColor: t.agentPresetColor,
    originalAgentPresetId: t.originalAgentPresetId,
    everDetectedAgent: t.everDetectedAgent,
    detectedAgentId: narrowDetectedAgentId(t.detectedAgentId),
    detectedProcessId: t.detectedProcessIconId,
  };
}
