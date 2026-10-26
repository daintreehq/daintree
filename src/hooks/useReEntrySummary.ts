import { useCallback, useEffect, useRef, useState } from "react";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { SEVERITY_WEIGHTS } from "@/lib/notificationSeverity";
import { APP_SOURCE_LABEL, worktreeNameFromId } from "@/lib/notificationSourceLabel";
import { isOtherProjectContext } from "@/lib/notificationDestination";

const MIN_BLUR_MS = 3000;

/** What a workspace row is called when the view's own project or scratch has no name to hand. */
const OWN_WORKSPACE_LABEL = "This project";

export interface SummaryRow {
  key: string;
  /** The worktree, the view's own project or scratch, or the app itself. */
  label: string;
  /**
   * The entry the row speaks for: the most severe, then the latest. Its title,
   * time and address are all read from here, so the row never pairs one
   * event's words with another's time or destination.
   */
  highlight: NotificationHistoryEntry;
  highlightTitle: string;
  entryCount: number;
}

export interface ReEntrySummaryState {
  visible: boolean;
  entries: NotificationHistoryEntry[];
  rows: SummaryRow[];
  overflowCount: number;
  /** When the summary was built: every row's age is told against this, not a ticking clock. */
  shownAt: number;
  dismiss: () => void;
}

/**
 * Every view hydrates the same notification history, so an entry can name a
 * project this view doesn't own or come from another host altogether. Neither
 * can be reached from here. A record with no project id is this view's own,
 * except one addressed only to a panel: an installed plugin's notice about one
 * of its panels names no project and reaches every view, so only the view
 * holding that panel can claim it.
 */
function isFromThisView(
  entry: NotificationHistoryEntry,
  ownerId: string | undefined,
  panelsById: Readonly<Record<string, unknown>>
): boolean {
  const context = entry.context;
  if (context?.hostName) return false;
  if (isOtherProjectContext(context, ownerId)) return false;
  if (context?.panelId && !context.projectId && !context.worktreeId) {
    return panelsById[context.panelId] !== undefined;
  }
  return true;
}

function ownWorkspaceLabel(ownerId: string | undefined): string {
  if (!ownerId) return OWN_WORKSPACE_LABEL;
  const name =
    useProjectStore.getState().projects.find((p) => p.id === ownerId)?.name ??
    useScratchStore.getState().scratches.find((s) => s.id === ownerId)?.name;
  return name?.trim() || OWN_WORKSPACE_LABEL;
}

function buildSummaryRows(
  entries: NotificationHistoryEntry[],
  ownerId: string | undefined
): SummaryRow[] {
  // A worktree's entries share its row; one that names only the project gets
  // the project's row; one that names neither came from the app itself. The
  // last two stay apart so a disk-space warning is never put on the project.
  const groups = new Map<string, NotificationHistoryEntry[]>();
  for (const e of entries) {
    const key = e.context?.worktreeId
      ? `worktree:${e.context.worktreeId}`
      : e.context?.projectId
        ? "workspace"
        : "app";
    const group = groups.get(key);
    if (group) {
      group.push(e);
    } else {
      groups.set(key, [e]);
    }
  }

  const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees ?? new Map();

  const rows: SummaryRow[] = [];

  for (const [key, groupEntries] of groups) {
    let worst = groupEntries[0]!;
    for (let i = 1; i < groupEntries.length; i++) {
      const e = groupEntries[i]!;
      const ww = SEVERITY_WEIGHTS[e.type];
      const cw = SEVERITY_WEIGHTS[worst.type];
      if (ww > cw || (ww === cw && e.timestamp > worst.timestamp)) {
        worst = e;
      }
    }

    const worktreeId = worst.context?.worktreeId;
    const label = worktreeId
      ? worktrees.get(worktreeId)?.name?.trim() || worktreeNameFromId(worktreeId)
      : key === "workspace"
        ? ownWorkspaceLabel(ownerId)
        : APP_SOURCE_LABEL;

    rows.push({
      key,
      label,
      highlight: worst,
      highlightTitle: worst.title?.trim() || worst.message,
      entryCount: groupEntries.length,
    });
  }

  rows.sort((a, b) => {
    const sv = SEVERITY_WEIGHTS[b.highlight.type] - SEVERITY_WEIGHTS[a.highlight.type];
    if (sv !== 0) return sv;
    const cv = b.entryCount - a.entryCount;
    if (cv !== 0) return cv;
    return a.label.localeCompare(b.label);
  });

  return rows;
}

const EMPTY: ReEntrySummaryState = {
  visible: false,
  entries: [],
  rows: [],
  overflowCount: 0,
  shownAt: 0,
  dismiss: () => {},
};

export function useReEntrySummary(): ReEntrySummaryState {
  const blurTimeRef = useRef<number | null>(null);
  const [state, setState] = useState<Omit<ReEntrySummaryState, "dismiss">>({
    visible: false,
    entries: [],
    rows: [],
    overflowCount: 0,
    shownAt: 0,
  });

  const dismiss = useCallback(() => {
    setState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  useEffect(() => {
    const handleFocus = () => {
      if (!document.hasFocus()) return;

      const blurTime = blurTimeRef.current;
      blurTimeRef.current = null;
      const now = Date.now();
      if (blurTime === null || now - blurTime < MIN_BLUR_MS) return;

      const { entries, markSummarized } = useNotificationHistoryStore.getState();
      const ownerId = getViewWorkspaceId() ?? useProjectStore.getState().currentProject?.id;
      const { panelsById } = usePanelStore.getState();
      // Only what this summary shows is marked: an entry from another project
      // or host is left as it was, for the inbox and its own view to report.
      const unseen = entries.filter(
        (e) =>
          !e.seenAsToast &&
          !e.summarized &&
          e.timestamp >= blurTime &&
          isFromThisView(e, ownerId, panelsById)
      );
      if (unseen.length === 0) return;

      markSummarized(unseen.map((e) => e.id));

      const allRows = buildSummaryRows(unseen, ownerId);
      setState({
        visible: true,
        entries: unseen,
        rows: allRows.slice(0, 3),
        overflowCount: Math.max(0, allRows.length - 3),
        shownAt: now,
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
