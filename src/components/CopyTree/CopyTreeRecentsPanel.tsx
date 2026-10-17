import { useEffect, useId, useMemo } from "react";
import type { ReactNode } from "react";
import { FileCode, Folders, RefreshCw } from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import {
  useDeferredLoading,
  useDohertyGate,
  useSkeletonDisplayFloor,
} from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { useCopyTreeHistoryStore } from "@/store/copyTreeHistoryStore";
import { DEFAULT_COPYTREE_FORMAT } from "@/lib/copyTreeFormat";
import { formatBytes } from "@/lib/formatBytes";
import { formatTimeAgo } from "@/utils/timeAgo";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import type { CopyTreeHistoryRecord } from "@shared/types";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";

/**
 * How many recent runs the menu shows. Main keeps twenty per project so the
 * long tail survives a burst of one-off copies; the menu is a shortcut list,
 * not a browser, so it takes the newest handful.
 */
const RECENTS_LIMIT = 5;

/**
 * Options that change the run even when empty. `mergeCopyTreeOptions` backfills
 * `exclude` and `always` from project settings only when they are undefined —
 * an explicit `[]` or `""` switches that backfill off, so a record carrying one
 * is a different run from the toolbar's default and must stay listed.
 */
const EXPLICIT_EVEN_WHEN_EMPTY: ReadonlySet<string> = new Set(["exclude", "always"]);

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
 * Three shapes normalise to "default": an absent value, a `false` flag (which
 * the generator treats the same as an absent one), and an explicit `format`
 * equal to the default — the palette and MCP routes pass it where the toolbar
 * omits it, and the two mean the same run. An empty selection array is default
 * too, except for the two overrides above.
 */
function isPinnedDefault(record: CopyTreeHistoryRecord): boolean {
  return Object.entries(record.options).every(([key, value]) => {
    if (value === undefined || value === false) return true;
    if (key === "format") return value === DEFAULT_COPYTREE_FORMAT;
    if (EXPLICIT_EVEN_WHEN_EMPTY.has(key)) return false;
    if (Array.isArray(value)) return value.length === 0;
    return value === "";
  });
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
  const parts = [pluralize(fileCount, "file")];
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
  /** The combo shown beside the pinned entry, as the tooltip shows it. */
  shortcut?: string | null;
  /** The old one-click behavior, now one row deeper. */
  onCopyFullContext: () => void;
  /** Re-run a stored option set against the active worktree. */
  onRunRecent: (record: CopyTreeHistoryRecord) => void;
  /**
   * Open Project settings on the Context tab, where excludes and budgets live.
   * Absent in a scratch, which has no project settings to open (#13210).
   */
  onOpenContextSettings?: () => void;
  /** Forwarded to the content; the toolbar uses it to redirect focus on overflow eviction. */
  onCloseAutoFocus?: (event: Event) => void;
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
 * The store hooks live in `CopyTreeMenuItems` below, under Radix's presence
 * boundary, so the history snapshot pull still lands on first open.
 */
export function CopyTreeMenuContent({ onCloseAutoFocus, ...items }: CopyTreeMenuContentProps) {
  return (
    <DropdownMenuContent
      align="end"
      sideOffset={4}
      aria-label="Copy context"
      data-copy-tree-panel=""
      // Wide enough for a path and a trailing size on one line; the names
      // truncate past that rather than the menu growing to fit them.
      className="w-[280px]"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <CopyTreeMenuItems {...items} />
    </DropdownMenuContent>
  );
}

/**
 * The store-owning half, deliberately a CHILD of `DropdownMenuContent`: Radix's
 * presence boundary unmounts the content's descendants while the menu is
 * closed, not the component that renders the content. Holding the history
 * hooks here — rather than in `CopyTreeMenuContent`, which the toolbar mounts
 * unconditionally — is what keeps the store's snapshot pull on first open
 * instead of at app start.
 */
function CopyTreeMenuItems({
  shortcut,
  onCopyFullContext,
  onRunRecent,
  onOpenContextSettings,
}: Omit<CopyTreeMenuContentProps, "onCloseAutoFocus">) {
  const records = useCopyTreeHistoryStore((s) => s.records);
  const loading = useCopyTreeHistoryStore((s) => s.loading);
  const error = useCopyTreeHistoryStore((s) => s.error);
  const init = useCopyTreeHistoryStore((s) => s.init);
  const retry = useCopyTreeHistoryStore((s) => s.retry);
  const recentLabelId = useId();

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
  // take long enough to show this. Once shown, the floor keeps the bones from
  // flashing for a single frame when the read lands just past the gate.
  // `gated ||` covers the commit where the gate has just opened and the floor
  // has not caught up yet; without it that frame renders the empty or list
  // body and then swaps the skeleton in over it.
  const gated = useDohertyGate(loading);
  const floored = useSkeletonDisplayFloor(gated);
  const showLoading = gated || floored;
  const stillWorking = useDeferredLoading(loading, UI_STILL_WORKING_MS);

  let recentBody: ReactNode;
  if (showLoading) {
    recentBody = (
      <Skeleton label={stillWorking ? "Still working…" : "Loading recent copies"}>
        <RecentSkeletonRow nameWidth="w-32" />
        <RecentSkeletonRow nameWidth="w-20" />
        {stillWorking ? (
          <div aria-hidden="true" className="px-2.5 py-1.5 pl-8 text-xs text-text-secondary">
            Still working…
          </div>
        ) : null}
      </Skeleton>
    );
  } else if (loading) {
    recentBody = null;
  } else if (error && recents.length === 0) {
    recentBody = (
      <>
        <MenuStatusRow>Couldn't load recent copies</MenuStatusRow>
        <DropdownMenuItem
          // Stay open: the answer to a retry is the list, and it lands here.
          // This row unmounts the moment the pull starts, so focus moves to
          // the menu itself first — from there the arrow keys reach whatever
          // the retry brings back, where a removed row would strand them.
          onSelect={(event) => {
            event.preventDefault();
            const { target } = event;
            if (target instanceof HTMLElement) {
              target.closest<HTMLElement>('[role="menu"]')?.focus();
            }
            retry();
          }}
        >
          <RefreshCw data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </DropdownMenuItem>
      </>
    );
  } else if (recents.length === 0) {
    // Names an action that can actually populate this list. "Copy context"
    // could not: the entry above records a run with no options, which is the
    // pinned action itself and is filtered back out, so following that
    // invitation leaves the list empty and the message standing. Copying a
    // folder (the file browser's row menu) stores a scope, and a scoped run
    // does appear here.
    recentBody = <MenuStatusRow>Copy a folder to reuse it here</MenuStatusRow>;
  } else {
    recentBody = recents.map((record) => (
      <RecentRow key={record.id} record={record} onRunRecent={onRunRecent} />
    ));
  }

  return (
    <>
      <DropdownMenuItem
        onSelect={onCopyFullContext}
        aria-keyshortcuts={comboToAriaKeyshortcuts(shortcut, isMac())}
      >
        <Folders data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
        Copy full context
        <DropdownMenuShortcut shortcut={shortcut} />
      </DropdownMenuItem>

      <DropdownMenuSeparator />
      <DropdownMenuGroup aria-labelledby={recentLabelId}>
        <DropdownMenuLabel id={recentLabelId}>Recent</DropdownMenuLabel>
        {recentBody}
      </DropdownMenuGroup>

      {/* Where the excludes, always-include lists and size budgets that shape
          every copy actually live. Without this the menu is a dead end for
          someone who opened it wanting to change what a copy contains. */}
      {onOpenContextSettings ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenContextSettings}>
            <FileCode data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Context settings
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * Where a scope name breaks: before its last path segment, so the leaf
 * survives a narrow menu. Two recents under the same parent differ only in
 * that leaf — `src/components/Layout` and `src/components/Settings` — and
 * end-truncation cut exactly that part off both. The leaf keeps its slash so
 * the two halves still read as one path across the ellipsis.
 *
 * Only a bare segment is a leaf. A name that ends in prose — an MCP caller's
 * "… shared/types/ipc as markdown" — has no leaf worth pinning, and pinning one
 * truncates both halves at once.
 */
export function splitRecentName(name: string): { head: string; leaf: string } {
  const slash = name.lastIndexOf("/", name.length - 2);
  if (slash <= 0) return { head: name, leaf: "" };
  const leaf = name.slice(slash);
  if (/\s/.test(leaf)) return { head: name, leaf: "" };
  return { head: name.slice(0, slash), leaf };
}

/**
 * One stored run. The name truncates in the middle: the head gives way first
 * (its shrink weight dwarfs the leaf's), so the row reads `src/compo…/Layout`
 * rather than `src/components/Lay…`. The full name is the tooltip, the
 * accessible name, and the typeahead key — the trailing size and age are not
 * something anyone types to find a row.
 */
function RecentRow({
  record,
  onRunRecent,
}: {
  record: CopyTreeHistoryRecord;
  onRunRecent: (record: CopyTreeHistoryRecord) => void;
}) {
  const { head, leaf } = splitRecentName(record.name);
  const { ref: headRef, isTruncated } = useTruncationDetection();
  return (
    <DropdownMenuItem
      data-copy-tree-recent=""
      textValue={record.name}
      onSelect={() => onRunRecent(record)}
      // The trailing slot is aria-hidden by design; the full description,
      // file count included, goes into the name instead.
      aria-label={`${record.name}, ${formatRecentMeta(record)}`}
    >
      <TruncatedTooltip
        content={record.name}
        isTruncated={isTruncated}
        focusable={false}
        side="left"
        // A path has no spaces to break on, so at the standard width it would
        // clip the tail this tooltip exists to reveal.
        contentClassName="[overflow-wrap:anywhere]"
      >
        <span className="flex min-w-0">
          <span ref={headRef} className="min-w-0 shrink-[1000] truncate">
            {head}
          </span>
          {leaf ? <span className="min-w-0 truncate">{leaf}</span> : null}
        </span>
      </TruncatedTooltip>
      {/* Native title, as `TimeAgo` does: the exact time one hover away, without
          a second tooltip trigger nested in the row. */}
      <DropdownMenuMeta className="shrink-0" title={new Date(record.lastUsedAt).toLocaleString()}>
        {formatRecentTrailing(record)}
      </DropdownMenuMeta>
    </DropdownMenuItem>
  );
}

/**
 * A sentence inside the menu that is not a command: the empty and failure
 * notes. Not a disabled item — a disabled row reads as an action that is
 * switched off, at half contrast, when it is an instruction the user needs to
 * read. `pl-8` is the label column the icon gutter rule gives text-only items;
 * that rule only matches `menuitem`s, so this row states it itself.
 */
function MenuStatusRow({ children }: { children: ReactNode }) {
  return <div className="px-2.5 py-1.5 pl-8 text-xs text-text-secondary">{children}</div>;
}

/** Bones on the same 28px pitch and columns as a recent row, so the list lands without a jump. */
function RecentSkeletonRow({ nameWidth }: { nameWidth: string }) {
  return (
    <div className="flex h-7 items-center justify-between px-2.5 pl-8">
      <SkeletonBone immediate className={cn("h-2.5", nameWidth)} />
      <SkeletonBone immediate className="h-2 w-20" />
    </div>
  );
}
