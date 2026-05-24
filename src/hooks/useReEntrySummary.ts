import { useCallback, useEffect, useRef, useState } from "react";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { SEVERITY_WEIGHTS } from "@/lib/notificationSeverity";

const MIN_BLUR_MS = 3000;

export interface WorktreeRow {
  worktreeId: string;
  worktreeName: string;
  worstType: NotificationHistoryEntry["type"];
  highlightTitle: string;
  entryCount: number;
}

export interface ReEntrySummaryState {
  visible: boolean;
  entries: NotificationHistoryEntry[];
  rows: WorktreeRow[];
  overflowCount: number;
  dismiss: () => void;
}

function buildWorktreeRows(entries: NotificationHistoryEntry[]): WorktreeRow[] {
  const byWorktree = new Map<string, NotificationHistoryEntry[]>();

  for (const e of entries) {
    const wid = e.context?.worktreeId;
    if (!wid) continue;
    const group = byWorktree.get(wid);
    if (group) {
      group.push(e);
    } else {
      byWorktree.set(wid, [e]);
    }
  }

  const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees ?? new Map();

  const rows: WorktreeRow[] = [];

  for (const [worktreeId, groupEntries] of byWorktree) {
    let worst = groupEntries[0]!;
    for (let i = 1; i < groupEntries.length; i++) {
      const e = groupEntries[i]!;
      const ww = SEVERITY_WEIGHTS[e.type];
      const cw = SEVERITY_WEIGHTS[worst.type];
      if (ww > cw || (ww === cw && e.timestamp > worst.timestamp)) {
        worst = e;
      }
    }

    const worktreeName = worktrees.get(worktreeId)?.name?.trim() || worktreeId.slice(0, 12);

    rows.push({
      worktreeId,
      worktreeName,
      worstType: worst.type,
      highlightTitle: worst.title?.trim() || worst.message,
      entryCount: groupEntries.length,
    });
  }

  rows.sort((a, b) => {
    const sv = SEVERITY_WEIGHTS[b.worstType] - SEVERITY_WEIGHTS[a.worstType];
    if (sv !== 0) return sv;
    const cv = b.entryCount - a.entryCount;
    if (cv !== 0) return cv;
    return a.worktreeName.localeCompare(b.worktreeName);
  });

  return rows;
}

const EMPTY: ReEntrySummaryState = {
  visible: false,
  entries: [],
  rows: [],
  overflowCount: 0,
  dismiss: () => {},
};

export function useReEntrySummary(): ReEntrySummaryState {
  const blurTimeRef = useRef<number | null>(null);
  const [state, setState] = useState<Omit<ReEntrySummaryState, "dismiss">>({
    visible: false,
    entries: [],
    rows: [],
    overflowCount: 0,
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

      const allRows = buildWorktreeRows(unseen);
      if (allRows.length === 0) return;
      setState({
        visible: true,
        entries: unseen,
        rows: allRows.slice(0, 3),
        overflowCount: Math.max(0, allRows.length - 3),
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
