import { create } from "zustand";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

interface UIState {
  // Ordered LIFO stack of overlay claims — the last entry is the topmost
  // overlay. Idempotent registration: re-adding an id is a no-op and the
  // array reference is preserved so Zustand skips re-renders.
  overlayStack: string[];
  // Monotonic count of claims ever registered. Claim ids are not unique over
  // time — a dialog that closes and reopens at the same position keeps its
  // `useId()` — so comparing stack contents cannot tell "never moved" from
  // "closed and reopened". Snapshot this to detect the latter.
  overlayClaimEpoch: number;
  addOverlayClaim: (id: string) => void;
  removeOverlayClaim: (id: string) => void;
  hasOpenOverlays: () => boolean;
  notificationCenterOpen: boolean;
  openNotificationCenter: () => void;
  closeNotificationCenter: () => void;
  toggleNotificationCenter: () => void;
  // Epoch ms recorded when the notification center was last closed. Used by
  // the "New since you last looked" divider to mark entries arriving after
  // the user's most recent visit. In-memory only — a fresh session starts
  // at 0 (no divider until the first close).
  lastNotificationCenterClosedAt: number;
  resetNotificationCenterLastClosedAt: () => void;
  // Per-worktree disclosure state for the Review Hub file list. Default
  // (unset) is EXPANDED — only an explicit collapse writes `false` here (see
  // the disclosure comment in ReviewHubContent). Session-scoped (in-memory
  // only, no persist middleware), so a collapse never survives a restart.
  reviewHubFileListExpanded: Record<string, boolean>;
  setReviewHubFileListExpanded: (worktreePath: string, expanded: boolean) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  overlayStack: [],
  overlayClaimEpoch: 0,

  // Idempotent — return the same state reference when the claim is already
  // present so Zustand skips re-renders. Never mutate the existing array; a
  // new instance is required so reference-equality subscribers update.
  addOverlayClaim: (id) =>
    set((state) => {
      if (state.overlayStack.includes(id)) return state;
      return {
        overlayStack: [...state.overlayStack, id],
        overlayClaimEpoch: state.overlayClaimEpoch + 1,
      };
    }),

  removeOverlayClaim: (id) =>
    set((state) => {
      if (!state.overlayStack.includes(id)) return state;
      return { overlayStack: state.overlayStack.filter((x) => x !== id) };
    }),

  hasOpenOverlays: () => get().overlayStack.length > 0,

  notificationCenterOpen: false,
  lastNotificationCenterClosedAt: 0,
  openNotificationCenter: () => {
    useNotificationHistoryStore.getState().resetEvictedCount();
    set({ notificationCenterOpen: true });
  },
  closeNotificationCenter: () =>
    set((state) => {
      if (!state.notificationCenterOpen) return state;
      return { notificationCenterOpen: false, lastNotificationCenterClosedAt: Date.now() };
    }),
  toggleNotificationCenter: () =>
    set((state) => {
      const next = !state.notificationCenterOpen;
      // Reset only on the closed → open transition; closing the center
      // should not silently zero an unread arrival counter.
      if (next) {
        useNotificationHistoryStore.getState().resetEvictedCount();
        return { notificationCenterOpen: next };
      }
      return { notificationCenterOpen: next, lastNotificationCenterClosedAt: Date.now() };
    }),
  resetNotificationCenterLastClosedAt: () => set({ lastNotificationCenterClosedAt: 0 }),

  reviewHubFileListExpanded: {},
  setReviewHubFileListExpanded: (worktreePath, expanded) =>
    set((state) => {
      if (state.reviewHubFileListExpanded[worktreePath] === expanded) return state;
      return {
        reviewHubFileListExpanded: {
          ...state.reviewHubFileListExpanded,
          [worktreePath]: expanded,
        },
      };
    }),
}));
