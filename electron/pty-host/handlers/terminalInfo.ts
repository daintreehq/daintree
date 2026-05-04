import { isBuiltInAgentId, type BuiltInAgentId } from "../../../shared/config/agentIds.js";
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
 */
export function mapTerminalInfo(t: NonNullable<TerminalInfoLike>, ctx: HostContext) {
  return {
    id: t.id,
    projectId: t.projectId,
    kind: t.kind,

    launchAgentId: t.launchAgentId,
    title: t.title,
    cwd: t.cwd,
    agentState: t.agentState,
    waitingReason: t.waitingReason,
    lastStateChange: t.lastStateChange,
    spawnedAt: t.spawnedAt,
    isTrashed: ctx.ptyManager.isInTrash(t.id),
    trashExpiresAt: t.trashExpiresAt,
    activityTier: ctx.ptyManager.getActivityTier(t.id),
    hasPty: !t.wasKilled && !t.isExited,
    agentSessionId: t.agentSessionId,
    agentLaunchFlags: t.agentLaunchFlags,
    agentModelId: t.agentModelId,
    agentPresetId: t.agentPresetId,
    agentPresetColor: t.agentPresetColor,
    originalAgentPresetId: t.originalAgentPresetId,
    everDetectedAgent: t.everDetectedAgent,
    detectedAgentId: narrowDetectedAgentId(t.detectedAgentId),
    detectedProcessId: t.detectedProcessIconId,
  };
}
