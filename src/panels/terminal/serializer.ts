import { sanitizeAgentEnv } from "@/config/agents";
import { stripAssignedSessionIdArgs } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export type PtySerializeInput = PtyPanelData;

export function serializePtyPanel(t: PtySerializeInput): Partial<PanelSnapshot> {
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
  return {
    launchAgentId: t.launchAgentId,
    cwd: t.cwd,
    command: command || undefined,
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
    ...(t.agentSessionId && { agentSessionId: t.agentSessionId }),
    ...(t.agentLaunchFlags?.length && { agentLaunchFlags: t.agentLaunchFlags }),
    ...(env && { env }),
    ...(t.agentModelId && { agentModelId: t.agentModelId }),
    ...(t.agentPresetId && { agentPresetId: t.agentPresetId }),
    ...(t.agentPresetColor && { agentPresetColor: t.agentPresetColor }),
    ...(t.originalPresetId && { originalPresetId: t.originalPresetId }),
    ...(t.isUsingFallback && { isUsingFallback: true }),
    ...(typeof t.fallbackChainIndex === "number" && { fallbackChainIndex: t.fallbackChainIndex }),
    // worktreeMoveNotice intentionally omitted — it's a live prompt to tell a
    // running agent where to go (#11853). Persisting it would resurface the
    // banner for a process that no longer exists after a restart.
    // sessionLostOnRestore intentionally omitted — it's a transient restore-time
    // signal. Persisting it would resurface the "Session no longer reachable"
    // banner on every subsequent restart (issue #9802).
    // "directing" is a renderer-only ephemeral state owned by
    // TerminalAgentStateController; persisting it could resurrect a stuck
    // indicator on the next reload (issue #5832).
    ...(t.agentState && t.agentState !== "directing" && { agentState: t.agentState }),
    ...(t.lastStateChange !== undefined && { lastStateChange: t.lastStateChange }),
  };
}
