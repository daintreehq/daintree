import type { PtyPanelData, TerminalRuntimeIdentity } from "@shared/types/panel";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import {
  deriveTerminalRuntimeIdentity,
  terminalRuntimeIdentitiesEqual,
} from "@/utils/terminalChrome";
import { getDefaultTitle } from "@/store/slices/panelRegistry/helpers";

export interface AgentDetectedReducerInput {
  nextDetectedAgentId: BuiltInAgentId | undefined;
  nextDetectedProcessId: string | undefined;
  nextEverDetectedAgent: true | undefined;
  timestamp: number;
}

export interface AgentDetectedReducerResult {
  patch: Partial<PtyPanelData>;
  shouldPromoteAgentId: BuiltInAgentId | null;
}

export interface AgentExitedReducerInput {
  hasAgentType: boolean;
  exitKind: "subcommand" | "terminal" | undefined;
  timestamp: number;
}

export function reduceAgentDetected(
  terminal: PtyPanelData,
  input: AgentDetectedReducerInput
): AgentDetectedReducerResult | null {
  const { nextDetectedAgentId, nextDetectedProcessId, nextEverDetectedAgent, timestamp } = input;

  const needsIconUpdate =
    nextDetectedProcessId !== undefined && terminal.detectedProcessId !== nextDetectedProcessId;
  const needsStickyUpdate = nextEverDetectedAgent === true && terminal.everDetectedAgent !== true;
  const needsAgentIdUpdate =
    nextDetectedAgentId !== undefined && terminal.detectedAgentId !== nextDetectedAgentId;

  const nextRuntimeIdentity: TerminalRuntimeIdentity | null = deriveTerminalRuntimeIdentity({
    detectedAgentId: nextDetectedAgentId,
    detectedProcessId: nextDetectedProcessId,
  });
  const needsRuntimeIdentityUpdate = !terminalRuntimeIdentitiesEqual(
    terminal.runtimeIdentity,
    nextRuntimeIdentity
  );
  const shouldSeedAgentState =
    nextDetectedAgentId !== undefined &&
    (terminal.agentState === undefined || terminal.agentState === "exited");

  const titleMode = terminal.titleMode ?? "default";
  const computedTitle = needsAgentIdUpdate
    ? getDefaultTitle(terminal.kind, {
        detectedAgentId: nextDetectedAgentId,
        launchAgentId: terminal.launchAgentId,
        everDetectedAgent: terminal.everDetectedAgent,
      })
    : undefined;
  const needsTitleUpdate =
    titleMode === "default" &&
    computedTitle !== undefined &&
    computedTitle.length > 0 &&
    terminal.title !== computedTitle;

  if (
    !needsIconUpdate &&
    !needsStickyUpdate &&
    !needsAgentIdUpdate &&
    !needsRuntimeIdentityUpdate &&
    !shouldSeedAgentState &&
    !needsTitleUpdate
  ) {
    return null;
  }

  const patch: Partial<PtyPanelData> = {
    ...(needsIconUpdate && { detectedProcessId: nextDetectedProcessId }),
    ...(needsStickyUpdate && { everDetectedAgent: true }),
    ...(needsAgentIdUpdate && { detectedAgentId: nextDetectedAgentId }),
    ...(needsRuntimeIdentityUpdate && {
      runtimeIdentity: nextRuntimeIdentity ?? undefined,
    }),
    ...(shouldSeedAgentState && {
      agentState: "idle" as const,
      lastStateChange: timestamp,
    }),
    ...(needsTitleUpdate && { title: computedTitle }),
  };

  // Runtime detection still applies the in-process agent policies
  // (scrollback/activity handlers). Launch affinity can brand the shell
  // before this event, but detection confirms which live agent owns the
  // PTY instance.
  const shouldPromoteAgentId =
    nextDetectedAgentId &&
    (needsAgentIdUpdate || needsRuntimeIdentityUpdate || shouldSeedAgentState)
      ? nextDetectedAgentId
      : null;

  return { patch, shouldPromoteAgentId };
}

export function reduceAgentExited(
  terminal: PtyPanelData,
  input: AgentExitedReducerInput
): Partial<PtyPanelData> | null {
  const { hasAgentType, exitKind, timestamp } = input;

  const clearProcess = terminal.detectedProcessId !== undefined;
  const clearDetectedAgent = terminal.detectedAgentId !== undefined;
  const clearRuntimeIdentity = terminal.runtimeIdentity !== undefined;
  const shouldMarkAgentExited =
    clearDetectedAgent || hasAgentType || exitKind === "subcommand" || exitKind === "terminal";
  const needsAgentStateExited = shouldMarkAgentExited && terminal.agentState !== "exited";

  // After demotion, detectedAgentId is cleared and agentState becomes
  // exited, so deriveTerminalChrome ignores durable launch affinity and
  // the title reverts to "Terminal".
  const titleMode = terminal.titleMode ?? "default";
  const computedTitle = shouldMarkAgentExited
    ? getDefaultTitle(terminal.kind, {
        detectedAgentId: undefined,
        launchAgentId: terminal.launchAgentId,
        everDetectedAgent: true,
        agentState: "exited",
      })
    : undefined;
  const needsTitleUpdate =
    titleMode === "default" && computedTitle !== undefined && terminal.title !== computedTitle;

  if (
    !clearProcess &&
    !clearDetectedAgent &&
    !clearRuntimeIdentity &&
    !needsAgentStateExited &&
    !needsTitleUpdate
  ) {
    return null;
  }

  return {
    ...(clearProcess && { detectedProcessId: undefined }),
    ...(clearDetectedAgent && { detectedAgentId: undefined }),
    ...(clearRuntimeIdentity && { runtimeIdentity: undefined }),
    ...(needsAgentStateExited && {
      agentState: "exited" as const,
      lastStateChange: timestamp,
    }),
    ...(needsTitleUpdate && { title: computedTitle }),
  };
}
