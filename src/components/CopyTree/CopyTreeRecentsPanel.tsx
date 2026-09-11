import { useEffect, useMemo } from "react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useCopyTreeHistoryStore } from "@/store/copyTreeHistoryStore";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";
import { formatBytes } from "@/lib/formatBytes";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { CopyTreeHistoryRecord } from "@shared/types";

/**
 * How many recent runs the menu shows. Main keeps twenty per project so the
 * long tail survives a burst of one-off copies; the menu is a shortcut list,
 * not a browser, so it takes the newest handful.
 */
const RECENTS_LIMIT = 5;

/**
 * Whether a stored run is the pinned action wearing a different hat.
 *
 * Records hold the caller's runtime options *before* project settings are
 * merged in, so a full-context copy is recorded with no options at all — which
 * is exactly what the menu's own "Copy full context" entry dispatches. Left in
 * the list it renders as a second copy of the entry directly above it, and the
 * user has to stop and work out whether the two differ. The dominant action is
 * not repeated inside the menu it anchors.
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
 * The full description of a recent: how big the run was and when it last ran.
 * This is the entry's accessible name; the visible trailing slot shows the
 * shorter `formatRecentTrailing` because a menu row is one line wide.
 *
 * Deliberately not `formatCopyResultMessage` — that composes a completion
 * sentence for the toast that announces a copy just happened, which is the
 * wrong tense for a list of copies the user might repeat.
 *
 * `totalSize` rides on the run result's optional stats, so a run that reported
 * no size is described without one rather than padded with a zero. A
 * non-default format is named because it changes what lands on the clipboard
 * and nothing else in the row says so; the default is left unsaid.
 *
 * `formatTimeAgo` rather than `formatRelativeTime`: "11d ago" carries the same
 * information as "11 days ago" in a third of the width, and the verbose
 * formatter stays with the settings tables that have room for it.
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
 * What fits beside a name on one menu line: the size, because it is the one
 * fact that changes what the user does next, and the age, because it is how
 * they recognise the run. The file count and a non-default format live in the
 * accessible name only — a third token here was what truncated the names.
 */
export function formatRecentTrailing(record: CopyTreeHistoryRecord, now?: number): string {
  const parts: string[] = [];
  if (record.stats.totalSize) parts.push(formatBytes(record.stats.totalSize));
  parts.push(formatTimeAgo(record.lastUsedAt, now));
  return parts.join(" · ");
}

interface CopyTreeMenuContentProps {
  /** The keybinding shown beside the pinned entry, as the tooltip shows it. */
  shortcut?: string | null;
  /** The old one-click behavior, now one row deeper. */
  onCopyFullContext: () => void;
  /** Re-run a stored option set against the active worktree. */
  onRunRecent: (record: CopyTreeHistoryRecord) => void;
  /** Open Project settings on the Context tab, where excludes and budgets live. */
  onOpenContextSettings: () => void;
}

/**
 * The copy-context toolbar menu (#11733).
 *
 * Six output formats, filters, scoped copies and MCP-named copy trees had all
 * collapsed behind one button that silently generated the full tree. This
 * menu keeps that copy one row away and lists the project's recent runs
 * beneath it.
 *
 * A plain `DropdownMenu`, the same primitive the toolbar's overflow menu two
 * icons over uses, and not the panel it replaced: it is a utility menu — open,
 * pick, gone — and the panel had grown a hero button, two-line rows, a footer
 * and its own focus-restoration plumbing to look like something else. The
 * primitive brings the density, arrow-key navigation, typeahead, and close-time
 * focus handling with it; nothing here restates any of that.
 *
 * Radix unmounts the content while the menu is closed, so the history store's
 * one-time snapshot pull still lands on first open rather than at app start.
 */
export function CopyTreeMenuContent({
  shortcut,
  onCopyFullContext,
  onRunRecent,
  onOpenContextSettings,
}: CopyTreeMenuContentProps) {
  const records = useCopyTreeHistoryStore((s) => s.records);
  const loading = useCopyTreeHistoryStore((s) => s.loading);
  const init = useCopyTreeHistoryStore((s) => s.init);

  // Idempotent at the store: later opens re-run this and return immediately.
  // The subscription deliberately outlives the menu — an MCP or context-menu
  // copy taken while it is closed still lands before the next open.
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

  // The pinned entry is usable immediately; only the recents wait, and under
  // the Doherty gate they wait silently. A local history read should never
  // take long enough to show this.
  const showLoading = useDohertyGate(loading);

  return (
    <DropdownMenuContent
      align="end"
      sideOffset={4}
      aria-label="Copy context"
      data-copy-tree-panel=""
      // Wide enough for a path and a trailing size on one line; the names
      // truncate past that rather than the menu growing to fit them.
      className="w-[280px]"
    >
      <DropdownMenuItem onSelect={onCopyFullContext}>
        Copy full context
        {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
      </DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Recent</DropdownMenuLabel>
      {loading ? (
        showLoading ? (
          <DropdownMenuItem disabled>Loading recent copies…</DropdownMenuItem>
        ) : null
      ) : recents.length === 0 ? (
        // Names an action that can actually populate this list. "Copy
        // context" could not: the entry above records a run with no options,
        // which is the pinned action itself and is filtered back out, so
        // following that invitation leaves the list empty and the message
        // standing. Copying a folder (the file browser's row menu) stores a
        // scope, and a scoped run does appear here.
        <DropdownMenuItem disabled>Copy a folder to reuse it here</DropdownMenuItem>
      ) : (
        recents.map((record) => (
          <DropdownMenuItem
            key={record.id}
            data-copy-tree-recent=""
            onSelect={() => onRunRecent(record)}
            // The trailing slot is aria-hidden by design; the full description,
            // file count included, goes into the name instead.
            aria-label={`${record.name}, ${formatRecentMeta(record)}`}
          >
            <span className="min-w-0 truncate">{record.name}</span>
            <DropdownMenuMeta className="shrink-0">{formatRecentTrailing(record)}</DropdownMenuMeta>
          </DropdownMenuItem>
        ))
      )}

      <DropdownMenuSeparator />
      {/* Where the excludes, always-include lists and size budgets that shape
          every copy actually live. Without this the menu is a dead end for
          someone who opened it wanting to change what a copy contains. */}
      <DropdownMenuItem onSelect={onOpenContextSettings}>Context settings</DropdownMenuItem>
    </DropdownMenuContent>
  );
}
