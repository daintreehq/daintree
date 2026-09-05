import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { PanelComponentProps } from "@/registry";
import type { ActivityState } from "@/components/Terminal/TerminalPane";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { clampZoom } from "@/components/Browser/browserUtils";
import { isPtyPanel, isBrowserPanel, isDevPreviewPanel } from "@shared/types/panel";

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
  const pty = isPtyPanel(terminal) ? terminal : undefined;
  const browser = isBrowserPanel(terminal) ? terminal : undefined;
  const devPreview = isDevPreviewPanel(terminal) ? terminal : undefined;

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
    everDetectedAgent: pty?.everDetectedAgent,
    agentId: pty?.launchAgentId,
    detectedAgentId: pty?.detectedAgentId,
    runtimeIdentity: pty?.runtimeIdentity,
    chrome: deriveTerminalChrome({
      kind: terminal.kind,
      launchAgentId: pty?.launchAgentId,
      runtimeIdentity: pty?.runtimeIdentity,
      detectedAgentId: pty?.detectedAgentId,
      detectedProcessId: pty?.detectedProcessId,
      agentState: pty?.agentState,
      runtimeStatus: pty?.runtimeStatus,
      exitCode: pty?.exitCode,
      presetColor: pty?.agentPresetColor,
    }),
    agentPresetId: pty?.agentPresetId,
    presetColor: pty?.agentPresetColor,
    agentLaunchFlags: pty?.agentLaunchFlags,
    cwd: pty?.cwd ?? devPreview?.cwd,
    agentState: pty?.agentState,
    activity: getStableActivity(
      terminal.id,
      pty?.activityHeadline,
      pty?.activityStatus,
      pty?.activityType
    ),
    activityStatus: pty?.activityStatus,
    lastCommand: pty?.lastCommand,
    flowStatus: pty?.flowStatus,
    restartKey: pty?.restartKey,
    restartError: pty?.restartError,
    reconnectError: pty?.reconnectError,
    spawnError: pty?.spawnError,
    scrollbackRestoreError: pty?.scrollbackRestoreError,
    attachError: pty?.attachError,
    detectedProcessId: pty?.detectedProcessId,

    // Extension state
    extensionState: terminal.extensionState,
    extensionStateVersion: terminal.extensionStateVersion,

    // Browser-specific
    initialUrl: browser?.browserUrl || "http://localhost:3000",
    initialHistory: browser?.browserHistory,
    initialZoom: clampZoom(browser?.browserZoom ?? 1.0),

    ...overrides,
  };
}
