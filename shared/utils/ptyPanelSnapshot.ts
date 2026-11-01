import { sanitizeAgentEnv } from "./agentPresets.js";
import { readSpawnProvenance } from "./scheduledRunProvenance.js";
import { stripAssignedSessionIdArgs } from "../types/agentSettings.js";
import type { PtyPanelData } from "../types/panel.js";
import type { PanelSnapshot } from "../types/project.js";

/**
 * The PTY-specific half of a terminal panel's saved snapshot. Shared by the
 * renderer's persistence and the host's viewless launch (#13495), so a panel
 * an agent launched with no window open is recorded exactly as a view would
 * have recorded it.
 */

/**
 * A full PTY panel record. Kept as the whole type so the field-coverage test,
 * which classifies every one of its keys, fails when a field is added.
 */
export type PtySerializeInput = PtyPanelData;

/** The fields the PTY fragment is built from; any full panel record carries them. */
export type PtySnapshotSource = Pick<
  PtyPanelData,
  | "launchAgentId"
  | "cwd"
  | "command"
  | "exitBehavior"
  | "agentSessionId"
  | "agentLaunchFlags"
  | "callerLaunchFlags"
  | "env"
  | "agentModelId"
  | "spawnedBy"
  | "scheduledRun"
  | "agentPresetId"
  | "agentPresetColor"
  | "originalPresetId"
  | "isUsingFallback"
  | "fallbackChainIndex"
  | "conversationCwd"
  | "restoreRecovery"
  | "restoreProvenance"
  | "lastAgentObservation"
  | "launchedByPluginId"
  | "holdOnRestart"
  | "scratchpad"
  | "firstPrompt"
  | "agentState"
  | "lastStateChange"
  | "runtimeStatus"
  | "exitCode"
  | "sessionPreservingExit"
>;

export function serializePtyPanel(t: PtySnapshotSource): Partial<PanelSnapshot> {
  // Sanitize the captured launch env on write so a compromised/edited on-disk
  // snapshot can't smuggle PATH/LD_PRELOAD or shell-injection values back in on
  // the next restore (#10922). Omitted entirely when nothing safe remains.
  const env = sanitizeAgentEnv(t.env);
  // A session-id-assigning flag is one-shot: the CLI rejects an id it has
  // already issued (#11782). Persisting it would hand that spent flag to any
  // restore path that replays the stored command instead of rebuilding one, and
  // the pane would come back failing to launch at all. The id itself is
  // persisted separately below, which is what restore actually resumes from.
  const command = stripAssignedSessionIdArgs(t.command?.trim() || "", t.launchAgentId);
  // A held pane has no process, so nothing about one is written for it — a
  // stale session id or agent state would let the next restore launch what the
  // hold is keeping back (#12434).
  const held = t.restoreRecovery !== undefined;
  // Only an exit the pane still shows (#15941). A session-preserving teardown
  // is restored with a new process, and an exit with no code was never seen.
  const shownExit =
    t.runtimeStatus === "exited" &&
    t.sessionPreservingExit !== true &&
    !held &&
    Number.isInteger(t.exitCode);
  return {
    launchAgentId: t.launchAgentId,
    cwd: t.cwd,
    command: command || undefined,
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
    ...(t.agentSessionId && !held && { agentSessionId: t.agentSessionId }),
    ...(t.agentLaunchFlags?.length && { agentLaunchFlags: t.agentLaunchFlags }),
    ...(t.agentLaunchFlags?.length &&
      t.callerLaunchFlags?.length && { callerLaunchFlags: t.callerLaunchFlags }),
    ...(env && { env }),
    ...(t.agentModelId && { agentModelId: t.agentModelId }),
    // Written as a pair or not at all (#15977).
    ...readSpawnProvenance(t.spawnedBy, t.scheduledRun),
    ...(t.agentPresetId && { agentPresetId: t.agentPresetId }),
    ...(t.agentPresetColor && { agentPresetColor: t.agentPresetColor }),
    ...(t.originalPresetId && { originalPresetId: t.originalPresetId }),
    ...(t.isUsingFallback && { isUsingFallback: true }),
    ...(typeof t.fallbackChainIndex === "number" && { fallbackChainIndex: t.fallbackChainIndex }),
    ...(t.conversationCwd && { conversationCwd: t.conversationCwd }),
    ...(held && { restoreRecovery: t.restoreRecovery }),
    // Both written for a held pane too: they describe the pane, and the last
    // state observed for it, never a process the hold would start.
    ...(t.restoreProvenance && { restoreProvenance: t.restoreProvenance }),
    ...(t.lastAgentObservation && { lastAgentObservation: t.lastAgentObservation }),
    ...(t.launchedByPluginId && { launchedByPluginId: t.launchedByPluginId }),
    ...(t.holdOnRestart === true && { holdOnRestart: true as const }),
    // Written for a held pane too: the notes belong to the pane, not its process.
    ...(t.scratchpad && { scratchpad: t.scratchpad }),
    // Written for a held pane too: it is what the run was asked, not a process.
    ...(t.firstPrompt && { firstPrompt: t.firstPrompt }),
    // worktreeMoveNotice intentionally omitted — it's a live prompt to tell a
    // running agent where to go (#11853). Persisting it would resurface the
    // banner for a process that no longer exists after a restart.
    // sessionLostOnRestore intentionally omitted — it's a transient restore-time
    // signal. Persisting it would resurface the "Session no longer reachable"
    // banner on every subsequent restart (issue #9802).
    // "directing" is a renderer-only ephemeral state owned by
    // TerminalAgentStateController; persisting it could resurrect a stuck
    // indicator on the next reload (issue #5832).
    ...(t.agentState && t.agentState !== "directing" && !held && { agentState: t.agentState }),
    ...(t.lastStateChange !== undefined && !held && { lastStateChange: t.lastStateChange }),
    ...(shownExit && { exitCode: t.exitCode }),
  };
}
