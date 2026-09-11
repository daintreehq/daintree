import { useEffect, useId, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

/**
 * What a row will actually copy, spelled out for the tooltip.
 *
 * The row's name is derived from the option set and collapses it: two runs over
 * different subtrees of the same folder, or the same scope with different
 * excludes, can land on the same label. The name is what you scan; this is what
 * you check before committing to a re-run.
 *
 * Phrased as what the run *was*, never as what the next one will be. Recents
 * replay against the active worktree, so the stored counts describe a past run
 * over a possibly different tree — stating them as a forecast would be a
 * prediction this panel has no basis for.
 */
function describeRecentOptions(record: CopyTreeHistoryRecord): string[] {
  const { options } = record;
  const lines: string[] = [];
  const list = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value.join(", ") : value;

  if (options.scopePaths?.length) lines.push(`Scope: ${options.scopePaths.join(", ")}`);
  if (options.includePaths?.length) lines.push(`Include: ${options.includePaths.join(", ")}`);
  if (options.filter) lines.push(`Filter: ${list(options.filter)}`);
  if (options.exclude) lines.push(`Exclude: ${list(options.exclude)}`);
  if (options.always?.length) lines.push(`Always: ${options.always.join(", ")}`);
  if (options.modified) lines.push("Changed files only");
  if (options.format && options.format !== DEFAULT_COPYTREE_FORMAT) {
    lines.push(`Format: ${options.format}`);
  }
  if (options.scopeIgnoresIgnoreFiles) lines.push("Ignores the ignore files above the scope");
  if (lines.length === 0) lines.push("No filters — the whole worktree");

  lines.push(`Last run: ${formatRecentMeta(record)}`);
  return lines;
}

/** The section band's box, shared so the skeleton's reserved band cannot drift from the real one. */
const SECTION_BAND_CLASS = "px-2 pt-2 pb-1";

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
  "w-full flex flex-col gap-0.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left",
  "text-text-primary hover:bg-overlay-raised",
  "transition-colors",
  PALETTE_ROW_FOCUS_CLASS
);

interface CopyTreeRecentsPanelProps {
  /** The old one-click behavior, now one click deeper. */
  onCopyFullContext: () => void;
  /** Re-run a stored option set against the active worktree. */
  onRunRecent: (record: CopyTreeHistoryRecord) => void;
  /** Open Project settings on the Context tab, where excludes and budgets live. */
  onOpenContextSettings: () => void;
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
  onOpenContextSettings,
}: CopyTreeRecentsPanelProps) {
  const recentsLabelId = useId();
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
          // `px-2` rather than the size's own `px-4`, and no leading glyph: the
          // panel now has exactly one left edge, shared by this label, the
          // section band, every row title and every skeleton bone. The copy
          // concept still has its icon on the toolbar trigger this hangs from —
          // repeating it here bought an indent and nothing else.
          variant="contrast"
          className="w-full justify-start px-2"
        >
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
                    inset, same two-line pitch — and the section band is
                    reserved, so neither the indent nor the heading moves when
                    the real rows arrive. The title bone is the wider of the
                    pair: the meta line is the shorter one in the loaded state,
                    and previewing it the other way round advertises a hierarchy
                    the content then contradicts. */}
                <Skeleton label="Loading recent copies" className="flex flex-col">
                  <div className={cn(PALETTE_SECTION_LABEL_CLASS, SECTION_BAND_CLASS)}>
                    <SkeletonBone immediate heightPx={8} className="w-12" />
                  </div>
                  {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    <div key={i} className="flex flex-col gap-0.5 px-2 py-1.5">
                      <SkeletonBone immediate heightPx={14} className="w-2/3" />
                      <SkeletonBone immediate heightPx={10} className="w-1/2" />
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
            // Names an action that can actually populate this list. "Copy
            // context" could not: the button above records a run with no
            // options, which is the pinned action itself and is filtered back
            // out, so following that invitation left the list empty and the
            // same message standing — reading as history that failed to save.
            // Copying a folder (the file browser's row menu) stores a scope,
            // and a scoped run does appear here.
            //
            // No icon: the glyph was the same `History` mark the rows use, so
            // it read as a sixth row rather than an illustration, and it was
            // the only centred thing in a panel that is otherwise one hard
            // left edge. No description either — `zero-data` at `popover`
            // scale types it as `never`.
            <EmptyState
              variant="zero-data"
              scale="popover"
              title="Copy a folder to reuse it here"
              className="py-4"
            />
          ) : (
            <>
              {/* The rows were previously unlabelled, on the reasoning that the
                  framed button above them was itself the heading. It could not
                  do both jobs: with no label, a row reads as ambiguous between
                  a past run and a variant of the command above it.

                  Named for assistive tech too, not `aria-hidden`: the whole
                  point of the band is the distinction it draws, and hiding it
                  from the accessibility tree withholds that distinction from
                  exactly the users who cannot see the band. */}
              <div
                id={recentsLabelId}
                className={cn(PALETTE_SECTION_LABEL_CLASS, SECTION_BAND_CLASS)}
              >
                Recent
              </div>
              <ul className="flex flex-col" aria-labelledby={recentsLabelId}>
                {recents.map((record) => (
                  <li key={record.id}>
                    {/* On the row rather than the name, and unconditional
                        rather than truncation-gated. A name that fits is still
                        a lossy summary of its option set — two runs over
                        different subtrees can derive the same label — so the
                        thing worth disclosing is the options, and it is worth
                        disclosing whether or not the title happens to clip.
                        Radix opens it on keyboard focus as well as hover, so
                        the route that cannot point at a row gets it too. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onRunRecent(record)}
                          className={rowClass}
                        >
                          <span className="truncate text-sm">{record.name}</span>
                          <span className="truncate text-2xs text-text-secondary">
                            {formatRecentMeta(record)}
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" align="start" className="max-w-[280px]">
                        <span className="flex flex-col gap-0.5">
                          <span className="font-medium break-words">{record.name}</span>
                          {describeRecentOptions(record).map((line) => (
                            <span key={line} className="text-text-secondary break-words">
                              {line}
                            </span>
                          ))}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </ScrollShadow>

      {/* Outside the ScrollShadow, so it stays put while the list scrolls.
          Last in the tab order and visually quiet: the panel's job is the copy
          at the top, and this only has to be findable by someone who came here
          wanting to change what a copy includes. Without it the panel is a dead
          end for that person — the excludes, budgets and always-include lists
          all live in Project settings, and nothing here said so. */}
      <div className="p-2 border-t border-divider">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onOpenContextSettings}
          // No glyph: the panel's single left edge is the thing holding this
          // layout together, and a leading icon here would reopen the indent
          // the row glyphs were removed to close.
          className="w-full justify-start px-2"
        >
          <span className="truncate">Context settings</span>
        </Button>
      </div>
    </div>
  );
}
