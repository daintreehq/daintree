import type { TerminalInstance } from "@/store";
import type { PanelComponentProps } from "@/registry";

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
    agentId: terminal.agentId,
    cwd: terminal.cwd,
    agentState: terminal.agentState,
    activity: terminal.activityHeadline
      ? {
          headline: terminal.activityHeadline,
          status: terminal.activityStatus ?? "working",
          type: terminal.activityType ?? "interactive",
        }
      : null,
    lastCommand: terminal.lastCommand,
    flowStatus: terminal.flowStatus,
    restartKey: terminal.restartKey,
    restartError: terminal.restartError,
    reconnectError: terminal.reconnectError,
    spawnError: terminal.spawnError,

    // Browser-specific
    initialUrl: terminal.browserUrl || "http://localhost:3000",

    // Notes-specific
    notePath: (terminal as any).notePath,
    noteId: (terminal as any).noteId,
    scope: (terminal as any).scope,
    createdAt: (terminal as any).createdAt,

    ...overrides,
  };
}
