import { create } from "zustand";
import type { GlobalAssistantPhase } from "@shared/types/ipc/help";
import type { GlobalAssistantSlot } from "@shared/config/globalAssistantSessions";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";

/**
 * An earlier conversation to reopen in a global session, waiting for the
 * person to approve it (#18169): picked from the session's own menu, or asked
 * for by a plugin. One at a time in a view: another asked for while one waits
 * is turned away rather than queued behind it, since each names the run it
 * would replace.
 */
export interface PendingGlobalAssistantResume {
  requestId: string;
  slot: GlobalAssistantSlot;
  agentId: string;
  agentSessionId: string;
  /** The conversation's title, as main listed it: conversation text, never logged. */
  title: string;
  /** The session as the person is shown it, which the resume must still find. */
  expected: { generation: number; phase: GlobalAssistantPhase };
  /** The plugin that asked, by name; null when the person picked it here. */
  pluginName: string | null;
  /** A second global session exists beside the first, so the one switched is named. */
  namesSession: boolean;
}

interface GlobalAssistantResumeConfirmState {
  current: PendingGlobalAssistantResume | null;
  /** Bumped with each request, so the dialog is mounted only once one has been asked. */
  requestSeq: number;
}

export const useGlobalAssistantResumeConfirmStore = create<GlobalAssistantResumeConfirmState>(
  () => ({ current: null, requestSeq: 0 })
);

let stopWatchingView: (() => void) | null = null;

function settle(): void {
  stopWatchingView?.();
  stopWatchingView = null;
  useGlobalAssistantResumeConfirmStore.setState({ current: null });
}

/**
 * Ask the person; false when a request is already waiting here. A view put
 * away with the question open doesn't ask it, from the moment it is staged.
 */
export function stageGlobalAssistantResume(
  request: Omit<PendingGlobalAssistantResume, "requestId">
): boolean {
  const { current, requestSeq } = useGlobalAssistantResumeConfirmStore.getState();
  if (current !== null) return false;
  const requestId = crypto.randomUUID();
  // Watching before it's published, so a settle during publishing finds it.
  stopWatchingView?.();
  stopWatchingView = subscribeProjectViewLifecycle((phase) => {
    if (phase === "cached") takeGlobalAssistantResume(requestId);
  });
  useGlobalAssistantResumeConfirmStore.setState({
    current: { ...request, requestId },
    requestSeq: requestSeq + 1,
  });
  return true;
}

/**
 * Settle a request, once: whichever answer comes first takes it, and a second
 * for the same dialog finds nothing to act on.
 */
export function takeGlobalAssistantResume(requestId: string): PendingGlobalAssistantResume | null {
  const { current } = useGlobalAssistantResumeConfirmStore.getState();
  if (current?.requestId !== requestId) return null;
  settle();
  return current;
}

/** Decline whatever waits, for when the dialog that would ask can't render. */
export function declineGlobalAssistantResume(): void {
  settle();
}
