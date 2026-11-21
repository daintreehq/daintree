import { create } from "zustand";
import type { GlobalAssistantPhase } from "@shared/types/ipc/help";

/**
 * A plugin's hand-off to the global assistant, waiting for the person to
 * approve replacing its run (#18140). One at a time in a view: another asked
 * for while one waits is turned away rather than queued behind it, since each
 * names the run it would replace.
 */
export interface PendingGlobalAssistantReplacement {
  requestId: string;
  agentId: string;
  prompt: string;
  /** The run the person is shown, which the replacement must still find. */
  expected: { generation: number; phase: GlobalAssistantPhase };
  /** The agent that run is on, when one is starting or running. */
  currentAgentId: string | null;
  pluginName: string;
}

interface GlobalAssistantReplaceConfirmState {
  current: PendingGlobalAssistantReplacement | null;
  /** Bumped with each request, so the dialog is mounted only once one has been asked. */
  requestSeq: number;
}

export const useGlobalAssistantReplaceConfirmStore = create<GlobalAssistantReplaceConfirmState>(
  () => ({ current: null, requestSeq: 0 })
);

/** Ask the person; false when a request is already waiting here. */
export function stageGlobalAssistantReplacement(
  request: Omit<PendingGlobalAssistantReplacement, "requestId">
): boolean {
  const { current, requestSeq } = useGlobalAssistantReplaceConfirmStore.getState();
  if (current !== null) return false;
  useGlobalAssistantReplaceConfirmStore.setState({
    current: { ...request, requestId: crypto.randomUUID() },
    requestSeq: requestSeq + 1,
  });
  return true;
}

/**
 * Settle a request, once: whichever answer comes first takes it, and a second
 * for the same dialog finds nothing to act on.
 */
export function takeGlobalAssistantReplacement(
  requestId: string
): PendingGlobalAssistantReplacement | null {
  const { current } = useGlobalAssistantReplaceConfirmStore.getState();
  if (current?.requestId !== requestId) return null;
  useGlobalAssistantReplaceConfirmStore.setState({ current: null });
  return current;
}

/** Decline whatever waits, for when the dialog that would ask can't render. */
export function declineGlobalAssistantReplacement(): void {
  useGlobalAssistantReplaceConfirmStore.setState({ current: null });
}
