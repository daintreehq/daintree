import type React from "react";
import { useCallback, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { FileDecoration } from "@shared/types/forge";
import { shouldVirtualizeFileList } from "@/lib/fileListWindowing";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";
import { cn } from "@/lib/utils";
import { BaseBranchFileRow } from "./BaseBranchFileRow";

interface BaseBranchFileListProps {
  files: CrossWorktreeFile[];
  /** Forge-authored badges, keyed by path. Absent for most files. */
  decorations: Record<string, FileDecoration | undefined>;
  onOpenFile: (file: CrossWorktreeFile, trigger: HTMLElement) => void;
  onOpenDecorationUrl: (url: string) => void;
  /**
   * The hub's scroll container. Windowing happens against it rather than in a
   * scroller of this list's own, so the sticky "Changed vs {base}" band and the
   * rows below it stay in one continuous scroll.
   */
  scrollParent: HTMLElement | null;
}

interface BaseRowContext {
  decorations: Record<string, FileDecoration | undefined>;
  onOpenFile: (file: CrossWorktreeFile, trigger: HTMLElement) => void;
  onOpenDecorationUrl: (url: string) => void;
  onOpenButton: (path: string, button: HTMLButtonElement | null) => void;
}

/** Status is part of the key because a path can change status between refreshes. */
function computeBaseRowKey(_index: number, file: CrossWorktreeFile) {
  return `${file.status}:${file.path}`;
}

function renderBaseRow(index: number, file: CrossWorktreeFile, ctx: BaseRowContext) {
  const decoration = ctx.decorations[file.path];
  const url = decoration?.url;
  return (
    <BaseBranchFileRow
      file={file}
      rowIndex={index}
      openButtonRef={(button) => ctx.onOpenButton(file.path, button)}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => ctx.onOpenFile(file, e.currentTarget)}
      unresolvedDecoration={decoration}
      onBadgeClick={url ? () => ctx.onOpenDecorationUrl(url) : undefined}
    />
  );
}

/**
 * The windowed path's per-row wrapper: the static path's flex `gap-0.5` becomes
 * bottom padding inside the measured item, because a virtualizer places items
 * itself and never sees a gap between them.
 */
function renderVirtualizedBaseRow(index: number, file: CrossWorktreeFile, ctx: BaseRowContext) {
  return <div className="pb-0.5">{renderBaseRow(index, file, ctx)}</div>;
}

// Keyboard focus, never a ring: the row the keys are heading for takes it.
const PARKED_FOCUS = { preventScroll: true, focusVisible: false } as const;

function focusRow(button: HTMLButtonElement) {
  // Scrolled by hand so the hub scroller's padding keeps the row clear of the
  // sticky band above it, as the "Since review" rows do.
  button.focus({ preventScroll: true, focusVisible: true });
  button.scrollIntoView({ block: "nearest" });
}

/**
 * The Review Hub's "changed vs base branch" file list.
 *
 * Read-only next to the working-tree sections — no staging, no selection — and
 * its rows carry native buttons rather than listbox options on both paths. Up,
 * Down, Home and End move DOM focus between the rows' open buttons, as the
 * other two file lists step their cursors; a review-thread badge keeps its own
 * Tab stop and takes no part.
 */
export function BaseBranchFileList({
  files,
  decorations,
  onOpenFile,
  onOpenDecorationUrl,
  scrollParent,
}: BaseBranchFileListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // The file a key asked for while the window had it unmounted. Held by path,
  // not index: a refresh can renumber the list before the row arrives.
  const pendingFocusPathRef = useRef<string | null>(null);
  const virtualized = shouldVirtualizeFileList(files.length);

  // Delivers a held key's focus on the commit that mounts its row, and only
  // to focus still parked on the list: once the user has moved it, even Tab
  // onto another row here, the key must not take it back.
  const handleOpenButton = useCallback((path: string, button: HTMLButtonElement | null) => {
    if (button === null || pendingFocusPathRef.current !== path) return;
    pendingFocusPathRef.current = null;
    if (document.activeElement !== listRef.current) return;
    focusRow(button);
  }, []);

  const context: BaseRowContext = useMemo(
    () => ({ decorations, onOpenFile, onOpenDecorationUrl, onOpenButton: handleOpenButton }),
    [decorations, onOpenFile, onOpenDecorationUrl, handleOpenButton]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (keyBelongsToField(e)) return;
    const { target } = e;
    let from: number;
    if (target instanceof HTMLElement && target.dataset.baseRowIndex !== undefined) {
      from = Number(target.dataset.baseRowIndex);
    } else if (target === e.currentTarget && pendingFocusPathRef.current !== null) {
      // Parked while a row mounts: keep stepping from where the last key went.
      const pendingPath = pendingFocusPathRef.current;
      from = files.findIndex((file) => file.path === pendingPath);
      if (from === -1) return;
    } else {
      return;
    }
    // A persistent file list, so the arrows stop at its ends rather than wrap.
    const next = stepListboxCursor(e.key, from, files.length, { wrap: false });
    if (next === null) return;
    e.preventDefault();
    const list = e.currentTarget;
    const row = list.querySelector<HTMLButtonElement>(`[data-base-row-index="${next}"]`);
    if (row) {
      pendingFocusPathRef.current = null;
      focusRow(row);
      return;
    }
    const file = files[next];
    if (!virtualized || !file) return;
    // Only the virtualizer can place a row it has not mounted. The row that
    // has focus may unmount as the window moves, so focus waits on the list
    // itself rather than falling to the document.
    pendingFocusPathRef.current = file.path;
    list.focus(PARKED_FOCUS);
    // `start`, as the working-tree reveal uses: a `customScrollParent` list's
    // viewport arithmetic goes wrong for `center` below the fold.
    virtuosoRef.current?.scrollToIndex({ index: next, align: "start", behavior: "auto" });
  };

  // A request lives only while focus is parked on the list itself, so a later
  // return to it (a click on its padding) cannot revive a spent one.
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) pendingFocusPathRef.current = null;
  };

  let body: React.ReactNode;
  if (!virtualized) {
    body = files.map((file, index) => {
      const decoration = decorations[file.path];
      const url = decoration?.url;
      return (
        <BaseBranchFileRow
          key={`${file.status}:${file.path}`}
          file={file}
          rowIndex={index}
          onClick={(e) => onOpenFile(file, e.currentTarget)}
          unresolvedDecoration={decoration}
          onBadgeClick={url ? () => onOpenDecorationUrl(url) : undefined}
        />
      );
    });
  } else if (scrollParent !== null) {
    body = (
      <Virtuoso<CrossWorktreeFile, BaseRowContext>
        ref={virtuosoRef}
        data={files}
        context={context}
        customScrollParent={scrollParent}
        computeItemKey={computeBaseRowKey}
        itemContent={renderVirtualizedBaseRow}
        increaseViewportBy={200}
        skipAnimationFrameInResizeObserver
      />
    );
  } else {
    // Over the threshold but with nowhere to window yet: the scroll container
    // is an ancestor, so it only exists from the hub's first commit onward.
    // Render the empty body rather than the full static list — mounting
    // hundreds of rows for one frame, to unmount them on the next, is the cost
    // windowing exists to remove.
    body = null;
  }

  return (
    // Not a tab stop: the rows are. Focusable only so a key can park focus
    // here while the row it asked for mounts.
    <div
      ref={listRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={cn("px-2 py-1", !virtualized && "flex flex-col gap-0.5")}
      data-testid="base-branch-file-list"
    >
      {body}
    </div>
  );
}
