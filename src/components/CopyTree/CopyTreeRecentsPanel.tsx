import { useEffect, useMemo, useRef } from "react";
import { Folders, History } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  PALETTE_ROW_FOCUS_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useCopyTreeHistoryStore } from "@/store/copyTreeHistoryStore";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";
import { formatBytes } from "@/lib/formatBytes";
import { formatTimeAgo } from "@/utils/timeAgo";
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
 * Whether a stored run is the pinned action wearing a different hat.
 *
 * Records hold the caller's runtime options *before* project settings are
 * merged in, so a full-context copy is recorded with no options at all — which
 * is exactly what the panel's own "Copy full context" button dispatches. Left
 * in the list it renders as a second, apparently better-informed copy of the
 * button directly above it (it carries a file count and a size, which the
 * button does not), and the user has to stop and work out whether the two
 * differ. Fluent states the rule plainly: the dominant action is not repeated
 * inside the menu it anchors.
 *
 * Keyed on the options rather than the name: a record *named* "Full context"
 * that carries a format or an exclude is a genuinely different run and stays.
 * An explicit `format` equal to the default is the one exception worth
 * normalising, because the palette and MCP routes pass it where the toolbar
 * omits it, and the two mean the same run.
 */
function isPinnedDefault(record: CopyTreeHistoryRecord): boolean {
  return Object.entries(record.options).every(
    ([key, value]) =>
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (key === "format" && value === DEFAULT_COPYTREE_FORMAT)
  );
}

/**
 * The compact second line on a recent: how big the run was and when it last
 * ran. Deliberately not `formatCopyResultMessage` — that composes a completion
 * sentence ("Copied 12 files (3.4 KB) as XML to clipboard") for the toast that
 * announces a copy just happened, which is the wrong tense and far too long for
 * a list row describing a copy the user might repeat.
 *
 * `totalSize` rides on the run result's optional stats, so a run that reported
 * no size is shown without one rather than padded with a zero.
 *
 * A non-default format is named here rather than left to the row's title: it
 * changes what lands on the clipboard, and no other part of the row says so.
 * The default is left unsaid, because naming it on every row would spend the
 * line's scarcest resource on the one fact that is never news.
 *
 * `formatTimeAgo` rather than `formatRelativeTime`: this is a 320px row that
 * gets read in a second, and "11d ago" carries the same information as
 * "11 days ago" in a third of the width. The verbose formatter stays in place
 * for the settings tables and audit logs that have room for it.
 */
export function formatRecentMeta(record: CopyTreeHistoryRecord, now?: number): string {
  const { fileCount, totalSize } = record.stats;
  const parts = [fileCount === 1 ? "1 file" : `${fileCount.toLocaleString()} files`];
  if (totalSize) parts.push(formatBytes(totalSize));
  if (record.options.format && record.options.format !== DEFAULT_COPYTREE_FORMAT) {
    parts.push(record.options.format);
  }
  parts.push(formatTimeAgo(record.lastUsedAt, now));
  return parts.join(" · ");
}

// Rows carry no accent except the focus ring, which is the panel's one emphasis
// signal. Hover and focus deliberately no longer share a tone: they used to
// both paint `overlay-raised`, so a hovered row and the focused row were
// indistinguishable. Hover keeps the fill; focus keeps the ring and drops the
// fill, which is also what makes the two legible at the same time when the
// pointer is on one row and the keyboard is on another.
//
// `PALETTE_ROW_FOCUS_CLASS` rather than leaving the ring to the browser. There
// is no global outline rule — `*:focus-visible` in index.css sets only the
// transition, and the ring's colour and width are component-owned — so a row
// that declares none gets Chromium's default: a square, full-bleed rectangle
// that ignores the panel's padding and collides with the divider above it.
const rowClass = cn(
  "w-full flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left",
  "text-text-primary hover:bg-overlay-raised",
  "transition-colors",
  PALETTE_ROW_FOCUS_CLASS
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

  // Records arrive newest-first and project-scoped from Main. The default-run
  // filter comes before the cap, so dropping the duplicate frees a slot for a
  // real run rather than leaving a gap.
  const recents = useMemo(
    () => records.filter((record) => !isPinnedDefault(record)).slice(0, RECENTS_LIMIT),
    [records]
  );

  // The primary button paints immediately; only the recents section waits.
  // The bones are `immediate` because this gate has already proven the wait
  // exceeded the Doherty threshold — the class-level delay would gate it twice.
  const showSkeleton = useDohertyGate(loading);

  return (
    <div
      data-copy-tree-panel=""
      role="dialog"
      aria-label="Copy context"
      // Keeps its own 420px ceiling — this panel's proportions are not being
      // redesigned here — but stops that ceiling exceeding the room actually
      // left under the anchor, so a short window no longer runs the list off
      // the bottom of the screen. The variable comes from FixedDropdown's
      // positioning pass; the fallback preserves the previous behaviour if
      // this ever renders outside that shell. Same mechanism the notification
      // center adopted in #12061.
      className="w-[320px] max-h-[min(420px,var(--fixed-dropdown-available-height,420px))] flex flex-col"
    >
      {/* `border-border-strong`, not the `border-divider` hairline this used to
          draw. The rule is not decoration between two list rows — it is the
          boundary between the panel's pinned command and its history, the same
          job the palette's header band gives the same token. At the divider
          weight the two halves read as one undifferentiated stack. */}
      <div className="p-2 border-b border-border-strong">
        <Button
          ref={primaryRowRef}
          type="button"
          onClick={onCopyFullContext}
          // `contrast` is the house's neutral high-contrast CTA: a near-white
          // fill on dark themes and near-black on light, resolved from the text
          // tokens so it stays theme-aware without hardcoding either. It spends
          // no accent, which matters here because the focus ring is already the
          // region's one accent signal.
          //
          // What it replaces was a hairline border over a 2% fill — on the light
          // themes that is a 1.03:1 difference from the panel behind it, so the
          // control had no resting affordance at all and read as a disabled text
          // field. Its apparent importance was coming entirely from the focus
          // ring, and vanished the moment focus moved to a row.
          //
          // `px-2` rather than the size's own `px-4`, so the label sits in the
          // same column as the row titles below it.
          variant="contrast"
          className="w-full justify-start px-2 gap-2"
        >
          <Folders className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-left">
            Copy full context
          </span>
        </Button>
      </div>

      <ScrollShadow className="flex-1 min-h-0">
        {/* One stable child: the shadow hook observes firstElementChild, so it
            must outlive the skeleton/empty-state/list swaps below. */}
        <div className="px-2 pb-2">
          {loading ? (
            showSkeleton ? (
              <>
                {/* The bones sit on the row grid they are previewing — same
                    inset, same two-line pitch — so the list does not jump when
                    the real rows arrive. */}
                <Skeleton label="Loading recent copies" className="flex flex-col">
                  {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    <div key={i} className="flex flex-col gap-0.5 px-2 py-1.5">
                      <SkeletonBone immediate heightPx={14} className="w-1/2" />
                      <SkeletonBone immediate heightPx={10} className="w-2/3" />
                    </div>
                  ))}
                </Skeleton>
                {/* Sibling, never nested: the Skeleton wrapper's aria-busy
                    silences mutations inside its subtree. A local history read
                    should never take this long, so if it does the user needs to
                    be told rather than left watching a pulse. */}
                <SkeletonHint className="px-2 pb-1" />
              </>
            ) : null
          ) : recents.length === 0 ? (
            // Names what the next copy buys rather than what the list lacks.
            // No description: `zero-data` at `popover` scale types it as
            // `never`, so the pointer to where scoped and filtered copies are
            // configured has nowhere to go at this scale and is deliberately
            // left out rather than smuggled into the title.
            <EmptyState
              variant="zero-data"
              scale="popover"
              title="Copy context to reuse it here"
              icon={<History />}
              className="py-4"
            />
          ) : (
            <>
              {/* The rows were previously unlabelled, on the reasoning that the
                  framed button above them was itself the heading. It could not
                  do both jobs: with no label, a row reads as ambiguous between
                  a past run and a variant of the command above it. */}
              <div className={cn(PALETTE_SECTION_LABEL_CLASS, "px-2 pt-2 pb-1")} aria-hidden="true">
                Recent
              </div>
              <ul className="flex flex-col">
                {recents.map((record) => (
                  <li key={record.id}>
                    <button type="button" onClick={() => onRunRecent(record)} className={rowClass}>
                      {/* Gives the two-line row a baseline anchor and puts its
                          title in the same column as the button's label above.
                          `History` means one thing inside this panel — "a run
                          that already happened" — which is also what the empty
                          state uses it for. */}
                      <History
                        className="w-4 h-4 shrink-0 text-text-secondary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                        {/* Names are derived from the option set and run long —
                            a two-path scoped copy truncates mid-token, which
                            leaves the row unidentifiable. The tooltip measures
                            the element itself and opens on keyboard focus as
                            well as hover, so the rows stay distinguishable on
                            the route that cannot point at them. */}
                        <TruncatedTooltip content={record.name}>
                          <span className="truncate text-sm">{record.name}</span>
                        </TruncatedTooltip>
                        <span className="truncate text-2xs text-text-secondary">
                          {formatRecentMeta(record)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </ScrollShadow>
    </div>
  );
}
