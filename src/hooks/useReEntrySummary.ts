import { useCallback, useEffect, useRef, useState } from "react";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";

const MIN_BLUR_MS = 3000;

export interface ReEntryCounts {
  warning: number;
  error: number;
  success: number;
  info: number;
}

export interface ReEntrySummaryState {
  visible: boolean;
  entries: NotificationHistoryEntry[];
  counts: ReEntryCounts;
  singleWorktreeId: string | null;
  dismiss: () => void;
}

function computeCounts(entries: NotificationHistoryEntry[]): ReEntryCounts {
  const counts: ReEntryCounts = { warning: 0, error: 0, success: 0, info: 0 };
  for (const e of entries) {
    counts[e.type]++;
  }
  return counts;
}

function getSingleWorktreeId(entries: NotificationHistoryEntry[]): string | null {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.context?.worktreeId) ids.add(e.context.worktreeId);
  }
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

const EMPTY: ReEntrySummaryState = {
  visible: false,
  entries: [],
  counts: { warning: 0, error: 0, success: 0, info: 0 },
  singleWorktreeId: null,
  dismiss: () => {},
};

export function useReEntrySummary(): ReEntrySummaryState {
  const blurTimeRef = useRef<number | null>(null);
  const [state, setState] = useState<Omit<ReEntrySummaryState, "dismiss">>({
    visible: false,
    entries: [],
    counts: { warning: 0, error: 0, success: 0, info: 0 },
    singleWorktreeId: null,
  });

  const dismiss = useCallback(() => {
    setState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      if (!document.hasFocus()) return;

      const blurTime = blurTimeRef.current;
      blurTimeRef.current = null;
      if (blurTime === null || Date.now() - blurTime < MIN_BLUR_MS) return;

      const { entries, markSummarized } = useNotificationHistoryStore.getState();
      const unseen = entries.filter(
        (e) => !e.seenAsToast && !e.summarized && e.timestamp >= blurTime
      );
      if (unseen.length === 0) return;

      markSummarized(unseen.map((e) => e.id));
      setState({
        visible: true,
        entries: unseen,
        counts: computeCounts(unseen),
        singleWorktreeId: getSingleWorktreeId(unseen),
      });
    };

    const handleBlur = () => {
      blurTimeRef.current = Date.now();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  if (!state.visible) return { ...EMPTY, dismiss };

  return { ...state, dismiss };
}
