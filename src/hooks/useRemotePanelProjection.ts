import { useEffect } from "react";
import { getAgentConfig } from "@/config/agents";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { panelStoreApi } from "@/store";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getRuntimeAgentId, isAgentTerminal } from "@/utils/terminalType";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import type { RendererPanelProjectionPublish } from "@shared/types/ipc/remotePanelProjection";

const PUBLISH_DEBOUNCE_MS = 100;

function connectionState(panel: PtyPanelData): "live" | "starting" | "restored" | "exited" {
  if (panel.spawnStatus === "spawning") return "starting";
  if (
    panel.runtimeStatus === "exited" ||
    panel.runtimeStatus === "error" ||
    panel.agentState === "exited" ||
    panel.exitCode !== undefined
  ) {
    return "exited";
  }
  if (panel.hasPty === true) return "live";
  return "restored";
}

export function buildRemotePanelProjectionFromPanels(
  projectId: string,
  sourcePanels: readonly PanelInstance[]
): RendererPanelProjectionPublish {
  const panels: RendererPanelProjectionPublish["panels"] = [];
  for (const panel of sourcePanels) {
    if (!isPtyPanel(panel)) continue;
    if (panel.excludeFromPersistence === true || !panel.worktreeId) continue;
    if (panel.location === "trash" || panel.location === "overlay" || panel.location === "dialog") {
      continue;
    }
    const agentId = getRuntimeAgentId(panel) ?? panel.launchAgentId;
    if (!agentId || agentId === "daintree-assistant") continue;
    if (!isAgentTerminal(panel) && !panel.agentSessionId && panel.agentState !== "exited") continue;
    const agentConfig = getAgentConfig(agentId);
    if (!agentConfig) continue;
    const displayName = agentConfig.name;
    const launchGeneration = agentLifecycleLedger.currentGeneration(panel.id);
    panels.push({
      panelId: panel.id,
      worktreeSourceId: panel.worktreeId,
      agentId,
      ...(launchGeneration !== undefined ? { launchGeneration } : {}),
      placement: panel.location === "dock" ? "dock" : "grid",
      displayName,
      title: getTerminalDisplayTitle(panel, "full"),
      ...(panel.startedAt !== undefined ? { spawnedAt: panel.startedAt } : {}),
      spawnedRemotely: panel.spawnedBy === "remote",
      resumable: Boolean(panel.agentSessionId),
      connectionState: connectionState(panel),
    });
  }
  return { projectId, status: "available", panels };
}

export function buildRemotePanelProjection(projectId: string): RendererPanelProjectionPublish {
  const { panelIds, panelsById } = panelStoreApi.getState();
  const sourcePanels: PanelInstance[] = [];
  for (const panelId of panelIds) {
    const panel = panelsById[panelId];
    if (panel) sourcePanels.push(panel);
  }
  return buildRemotePanelProjectionFromPanels(projectId, sourcePanels);
}

export function useRemotePanelProjection(isHydrated: boolean): void {
  useEffect(() => {
    if (!window.electron?.remotePanelProjection) return;
    const projectId = getViewWorkspaceId();
    if (!projectId) return;
    if (!isHydrated) {
      safeFireAndForget(
        window.electron.remotePanelProjection.publish({ projectId, status: "loading", panels: [] }),
        { context: "remote-panel-projection:loading" }
      );
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const publish = () => {
      timer = null;
      if (disposed) return;
      safeFireAndForget(
        window.electron.remotePanelProjection.publish(buildRemotePanelProjection(projectId)),
        { context: "remote-panel-projection:publish" }
      );
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(publish, PUBLISH_DEBOUNCE_MS);
    };
    publish();
    const unsubscribe = panelStoreApi.subscribe(schedule);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [isHydrated]);
}
