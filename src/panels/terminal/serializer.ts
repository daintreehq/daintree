import type { PtyPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export type PtySerializeInput = PtyPanelData;

export function serializePtyPanel(t: PtySerializeInput): Partial<PanelSnapshot> {
  return {
    launchAgentId: t.launchAgentId,
    cwd: t.cwd,
    command: t.command?.trim() || undefined,
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
    ...(t.agentSessionId && { agentSessionId: t.agentSessionId }),
    ...(t.agentLaunchFlags?.length && { agentLaunchFlags: t.agentLaunchFlags }),
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
