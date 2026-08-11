import { sanitizeAgentEnv } from "@/config/agents";
import type { PtyPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export type PtySerializeInput = PtyPanelData;

export function serializePtyPanel(t: PtySerializeInput): Partial<PanelSnapshot> {
  // Sanitize the captured launch env on write so a compromised/edited on-disk
  // snapshot can't smuggle PATH/LD_PRELOAD or shell-injection values back in on
  // the next restore (#10922). Omitted entirely when nothing safe remains.
  const env = sanitizeAgentEnv(t.env);
  return {
    launchAgentId: t.launchAgentId,
    cwd: t.cwd,
    command: t.command?.trim() || undefined,
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
    ...(t.agentSessionId && { agentSessionId: t.agentSessionId }),
    ...(t.spawnedBy && { spawnedBy: t.spawnedBy }),
    ...(t.agentLaunchFlags?.length && { agentLaunchFlags: t.agentLaunchFlags }),
    ...(env && { env }),
    ...(t.agentModelId && { agentModelId: t.agentModelId }),
    ...(t.agentPresetId && { agentPresetId: t.agentPresetId }),
    ...(t.agentPresetColor && { agentPresetColor: t.agentPresetColor }),
    ...(t.originalPresetId && { originalPresetId: t.originalPresetId }),
    ...(t.isUsingFallback && { isUsingFallback: true }),
    ...(typeof t.fallbackChainIndex === "number" && { fallbackChainIndex: t.fallbackChainIndex }),
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
