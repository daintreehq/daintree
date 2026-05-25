import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { PanelComponentProps } from "@/registry";
import type { ActivityState } from "@/components/Terminal/TerminalPane";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { clampZoom } from "@/components/Browser/browserUtils";

// Carrier element from the legacy `panelsById` shape, sourced through
// `getNarrowPanel`'s parameter so this file doesn't import the deprecated
// `TerminalInstance` alias by name. Lets external callers that still hand
// out raw carrier entries pass through until the rest of the renderer
// migrates to `getNarrowPanel` (#8957).
type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

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
  terminal: CarrierPanel;
  isFocused: boolean;
  overrides: Partial<PanelComponentProps>;
}

export function buildPanelProps({
  terminal,
  isFocused,
  overrides,
}: BuildPanelPropsConfig): PanelComponentProps {
  return {
    id: terminal.id,
    title: terminal.title,
    worktreeId: terminal.worktreeId,

    isFocused,

    // Required by PanelComponentProps — overridden by caller
    onFocus: overrides.onFocus!,
    onClose: overrides.onClose!,

    // Terminal-specific
    type: undefined,
    everDetectedAgent: terminal.everDetectedAgent,
    agentId: terminal.launchAgentId,
    detectedAgentId: terminal.detectedAgentId,
    runtimeIdentity: terminal.runtimeIdentity,
    chrome: deriveTerminalChrome({
      kind: terminal.kind,
      launchAgentId: terminal.launchAgentId,
      runtimeIdentity: terminal.runtimeIdentity,
      detectedAgentId: terminal.detectedAgentId,
      detectedProcessId: terminal.detectedProcessId,
      agentState: terminal.agentState,
      runtimeStatus: terminal.runtimeStatus,
      exitCode: terminal.exitCode,
      presetColor: terminal.agentPresetColor,
    }),
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
    activityStatus: terminal.activityStatus,
    lastCommand: terminal.lastCommand,
    flowStatus: terminal.flowStatus,
    restartKey: terminal.restartKey,
    restartError: terminal.restartError,
    reconnectError: terminal.reconnectError,
    spawnError: terminal.spawnError,
    scrollbackRestoreError: terminal.scrollbackRestoreError,
    detectedProcessId: terminal.detectedProcessId,

    // Extension state
    extensionState: terminal.extensionState,

    // Browser-specific
    initialUrl: terminal.browserUrl || "http://localhost:3000",
    initialHistory: terminal.browserHistory,
    initialZoom: clampZoom(terminal.browserZoom ?? 1.0),

    ...overrides,
  };
}
