import { create } from "zustand";
import type { AgentUsageTrackingSnapshot } from "@shared/types/ipc/agentUsage";

interface AgentUsageTrackingState {
  /**
   * This machine's agent usage tracking switch (#17981), whichever host the
   * view's project lives on. Null until main first answers, so a view never
   * shows Usage, or asks for it, on a guess.
   */
  enabled: boolean | null;
  /** Main's revision of `enabled`; -1 until the first snapshot lands. */
  revision: number;
}

interface AgentUsageTrackingActions {
  /** Takes main's value unless this view already holds a newer revision. */
  applySnapshot: (snapshot: AgentUsageTrackingSnapshot) => void;
  /**
   * Turns tracking on or off for this machine. The view shows main's answer;
   * on failure it reads main again, and the error is rethrown.
   */
  setEnabled: (enabled: boolean) => Promise<void>;
}

export type AgentUsageTrackingStore = AgentUsageTrackingState & AgentUsageTrackingActions;

export const useAgentUsageTrackingStore = create<AgentUsageTrackingStore>()((set, get) => ({
  enabled: null,
  revision: -1,

  applySnapshot: (snapshot) => {
    if (snapshot.revision < get().revision) return;
    set({ enabled: snapshot.enabled, revision: snapshot.revision });
  },

  setEnabled: async (enabled) => {
    const api = window.electron?.agentUsage;
    if (!api) throw new Error("Agent usage tracking is unavailable");
    try {
      get().applySnapshot(await api.setTracking({ enabled }));
    } catch (error) {
      try {
        get().applySnapshot(await api.getTracking());
      } catch {
        // What this view last heard from main still stands.
      }
      throw error;
    }
  },
}));

/** First retry after a failed read; doubles up to the cap until main answers. */
const READ_RETRY_BASE_MS = 2_000;
const READ_RETRY_CAP_MS = 30_000;

/**
 * Keeps this view's copy of the switch current: subscribed before it is read,
 * so a change made between the two is never lost, and the revision drops a
 * read that a push overtook. A read that fails is tried again until main
 * answers, by a read or a push; until then the view shows no Usage.
 */
export function initAgentUsageTrackingSync(): () => void {
  const api = typeof window === "undefined" ? undefined : window.electron?.agentUsage;
  if (!api?.onTrackingChanged || !api.getTracking) return () => {};

  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const apply = (snapshot: AgentUsageTrackingSnapshot) => {
    if (!disposed) useAgentUsageTrackingStore.getState().applySnapshot(snapshot);
  };
  const read = () => {
    api.getTracking().then(apply, () => {
      if (disposed || useAgentUsageTrackingStore.getState().revision >= 0) return;
      retry = setTimeout(
        () => {
          // A push may have answered meanwhile.
          if (useAgentUsageTrackingStore.getState().revision < 0) read();
        },
        Math.min(READ_RETRY_CAP_MS, READ_RETRY_BASE_MS * 2 ** attempt++)
      );
    });
  };
  const unsubscribe = api.onTrackingChanged(apply);
  read();

  return () => {
    disposed = true;
    clearTimeout(retry);
    unsubscribe();
  };
}
