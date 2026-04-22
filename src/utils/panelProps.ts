import type { TerminalInstance } from "@/store";
import type { PanelComponentProps } from "@/registry";
import type { ActivityState } from "@/components/Terminal/TerminalPane";

const activityCache = new Map<string, ActivityState>();

function getStableActivity(
  id: string,
  headline: string | undefined,
  status: string | undefined,
  type: string | undefined
): ActivityState | null {
  if (!headline) {
    activityCache.delete(id);
    return null;
  }

  const resolvedStatus = (status ?? "working") as ActivityState["status"];
  const resolvedType = (type ?? "interactive") as ActivityState["type"];

  const cached = activityCache.get(id);
  if (
    cached &&
    cached.headline === headline &&
    cached.status === resolvedStatus &&
    cached.type === resolvedType
  ) {
    return cached;
  }

  const entry: ActivityState = {
    headline,
    status: resolvedStatus,
    type: resolvedType,
  };
  activityCache.set(id, entry);
  return entry;
}

export interface BuildPanelPropsConfig {
  terminal: TerminalInstance;
  isFocused: boolean;
  isTrashing: boolean;
  overrides: Partial<PanelComponentProps>;
}

export function buildPanelProps({
  terminal,
  isFocused,
  isTrashing,
  overrides,
}: BuildPanelPropsConfig): PanelComponentProps {
  return {
    id: terminal.id,
    title: terminal.title,
    worktreeId: terminal.worktreeId,

    isFocused,
    isTrashing,

    // Required by PanelComponentProps — overridden by caller
    onFocus: overrides.onFocus!,
    onClose: overrides.onClose!,

    // Terminal-specific
    type: terminal.type,
    everDetectedAgent: terminal.everDetectedAgent,
    agentId: terminal.agentId,
    detectedAgentId: terminal.detectedAgentId,
    agentPresetId: terminal.agentPresetId,
    presetColor: terminal.agentPresetColor,
    agentLaunchFlags: terminal.agentLaunchFlags,
    cwd: terminal.cwd,
    agentState: terminal.agentState,
    activity: getStableActivity(
      terminal.id,
      terminal.activityHeadline,
      terminal.activityStatus,
      terminal.activityType
    ),
    lastCommand: terminal.lastCommand,
    flowStatus: terminal.flowStatus,
    restartKey: terminal.restartKey,
    restartError: terminal.restartError,
    reconnectError: terminal.reconnectError,
    spawnError: terminal.spawnError,
    detectedProcessId: terminal.detectedProcessId,

    // Extension state
    extensionState: terminal.extensionState,

    // Browser-specific
    initialUrl: terminal.browserUrl || "http://localhost:3000",

    ...overrides,
  };
}
