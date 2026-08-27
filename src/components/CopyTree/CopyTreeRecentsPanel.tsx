import { useEffect, useRef } from "react";
import { Folders, History } from "@/components/icons";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useCopyTreeHistoryStore } from "@/store/copyTreeHistoryStore";
import { formatBytes } from "@/lib/formatBytes";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import type { CopyTreeHistoryRecord } from "@shared/types";

/**
 * How many recent runs the panel shows. Main keeps twenty per project so the
 * long tail survives a burst of one-off copies; the panel is a shortcut list,
 * not a browser, so it takes the newest handful.
 */
const RECENTS_LIMIT = 5;

/** Row count while hydrating — a plausible list, not the cap. */
const SKELETON_ROWS = 3;

/**
 * The compact second line on a recent: how big the run was and when it last
 * ran. Deliberately not `formatCopyResultMessage` — that composes a completion
 * sentence ("Copied 12 files (3.4 KB) as XML to clipboard") for the toast that
 * announces a copy just happened, which is the wrong tense and far too long for
 * a list row describing a copy the user might repeat.
 *
 * `totalSize` rides on the run result's optional stats, so a run that reported
 * no size is shown without one rather than padded with a zero.
 */
export function formatRecentMeta(record: CopyTreeHistoryRecord, now?: number): string {
  const { fileCount, totalSize } = record.stats;
  const parts = [fileCount === 1 ? "1 file" : `${fileCount} files`];
  if (totalSize) parts.push(formatBytes(totalSize));
  parts.push(formatRelativeTime(record.lastUsedAt, now));
  return parts.join(" · ");
}

// Rows carry no accent: hierarchy here comes from typography and placement, and
// the panel is one focus region where the focus ring is the only anchor that
// earns emphasis. The keyboard highlight rides the same neutral surface as
// hover rather than a second colour, and the app's default focus outline is
// left in place rather than replaced.
const rowClass = cn(
  "w-full flex items-center gap-2.5 px-3 py-2 text-left",
  "text-text-primary hover:bg-overlay-raised focus-visible:bg-overlay-raised",
  "transition-colors"
);

// The primary action is the panel's header: a framed button in its own padded
// band rather than the first row of the list, so it reads as "the button, with
// its history underneath" instead of one more entry. Neutral raised surface —
// the focus ring it takes on open is the region's one emphasis signal.
const primaryButtonClass = cn(
  "w-full flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2 text-left",
  "border border-divider bg-overlay-subtle text-text-primary hover:bg-overlay-raised",
  "transition-colors"
);

interface CopyTreeRecentsPanelProps {
  /** The old one-click behavior, now one click deeper. */
  onCopyFullContext: () => void;
  /** Re-run a stored option set against the active worktree. */
  onRunRecent: (record: CopyTreeHistoryRecord) => void;
}

/**
 * The copy-tree toolbar dropdown (#11733).
 *
 * Six output formats, filters, scoped copies and MCP-named copy trees had all
 * collapsed behind one button that silently generated the full tree. This panel
 * keeps that copy one click away and puts the project's recent runs beside it.
 *
 * Lazy-loaded and mounted only once the dropdown has opened, so the history
 * mirror's IPC pull is paid on first use rather than at app start.
 */
export function CopyTreeRecentsPanel({
  onCopyFullContext,
  onRunRecent,
}: CopyTreeRecentsPanelProps) {
  const records = useCopyTreeHistoryStore((s) => s.records);
  const loading = useCopyTreeHistoryStore((s) => s.loading);
  const init = useCopyTreeHistoryStore((s) => s.init);
  const primaryRowRef = useRef<HTMLButtonElement>(null);

  // The trigger advertises `aria-haspopup="dialog"`, and this panel is where
  // the button's own action now lives — so focus has to come in with it. The
  // dropdown portals to the end of <body>, so a keyboard user who left focus on
  // the trigger would otherwise have to tab through the whole app to reach
  // these rows. The body unmounts on close, so this runs once per open.
  useEffect(() => {
    primaryRowRef.current?.focus();
  }, []);

  // Idempotent at the store: later opens re-run this and return immediately.
  // The subscription deliberately outlives the panel — an MCP or context-menu
  // copy taken while the dropdown is closed still lands before the next open.
  useEffect(() => {
    init();
  }, [init]);

  // Records arrive newest-first and project-scoped from Main, so this is the
  // whole selection step.
  const recents = records.slice(0, RECENTS_LIMIT);

  // The primary button paints immediately; only the recents section waits.
  // The bones are `immediate` because this gate has already proven the wait
  // exceeded the Doherty threshold — the class-level delay would gate it twice.
  const showSkeleton = useDohertyGate(loading);

  return (
    <div
      data-copy-tree-panel=""
      role="dialog"
      aria-label="Copy context"
      className="w-[320px] max-h-[420px] flex flex-col"
    >
      {/* No headings: the framed primary button IS the header, and everything
          under the divider is self-evidently the run history — each row names
          its run and ends in a relative timestamp. */}
      <div className="p-1.5 border-b border-divider">
        <button
          ref={primaryRowRef}
          type="button"
          onClick={onCopyFullContext}
          className={primaryButtonClass}
        >
          <Folders className="w-4 h-4 shrink-0 text-daintree-text/70" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Copy full context</span>
        </button>
      </div>

      <ScrollShadow className="flex-1 min-h-0">
        {/* One stable child: the shadow hook observes firstElementChild, so it
            must outlive the skeleton/empty-state/list swaps below. */}
        <div className="py-1">
          {loading ? (
            showSkeleton ? (
              <>
                <Skeleton label="Loading recent copies" className="flex flex-col gap-2 px-3 py-2">
                  {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    <div key={i} className="flex flex-col gap-1.5">
                      <SkeletonBone immediate heightPx={12} className="w-1/2" />
                      <SkeletonBone immediate heightPx={10} className="w-2/3" />
                    </div>
                  ))}
                </Skeleton>
                {/* Sibling, never nested: the Skeleton wrapper's aria-busy
                    silences mutations inside its subtree. A local history read
                    should never take this long, so if it does the user needs to
                    be told rather than left watching a pulse. */}
                <SkeletonHint className="px-3 pb-2" />
              </>
            ) : null
          ) : recents.length === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="popover"
              title="Copy a context to start your recents"
              icon={<History />}
              className="py-6"
            />
          ) : (
            <ul className="flex flex-col">
              {recents.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    onClick={() => onRunRecent(record)}
                    className={cn(rowClass, "items-start")}
                  >
                    <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className="truncate text-sm">{record.name}</span>
                      <span className="truncate text-2xs text-daintree-text/50">
                        {formatRecentMeta(record)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollShadow>
    </div>
  );
}
