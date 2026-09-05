import type React from "react";
import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { FileDecoration } from "@shared/types/forge";
import { shouldVirtualizeFileList } from "@/lib/fileListWindowing";
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
}

/** Status is part of the key because a path can change status between refreshes. */
function computeBaseRowKey(_index: number, file: CrossWorktreeFile) {
  return `${file.status}:${file.path}`;
}

function renderBaseRow(_index: number, file: CrossWorktreeFile, ctx: BaseRowContext) {
  const decoration = ctx.decorations[file.path];
  const url = decoration?.url;
  return (
    <BaseBranchFileRow
      file={file}
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

/**
 * The Review Hub's "changed vs base branch" file list.
 *
 * Read-only next to the working-tree sections — no staging, no selection, no
 * keyboard cursor — so windowing it costs nothing but the threshold check. Its
 * rows carry native buttons rather than listbox options, and that stays true on
 * both paths.
 */
export function BaseBranchFileList({
  files,
  decorations,
  onOpenFile,
  onOpenDecorationUrl,
  scrollParent,
}: BaseBranchFileListProps) {
  const context: BaseRowContext = useMemo(
    () => ({ decorations, onOpenFile, onOpenDecorationUrl }),
    [decorations, onOpenFile, onOpenDecorationUrl]
  );

  // Same rule as the working-tree sections: over the threshold AND a scroll
  // container to window against. Before the hub's first commit there is no
  // element yet, and the static list is the correct thing to render.
  if (!shouldVirtualizeFileList(files.length) || scrollParent === null) {
    return (
      <div className="px-2 py-1 flex flex-col gap-0.5">
        {files.map((file) => {
          const decoration = decorations[file.path];
          const url = decoration?.url;
          return (
            <BaseBranchFileRow
              key={`${file.status}:${file.path}`}
              file={file}
              onClick={(e) => onOpenFile(file, e.currentTarget)}
              unresolvedDecoration={decoration}
              onBadgeClick={url ? () => onOpenDecorationUrl(url) : undefined}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className="px-2 py-1">
      <Virtuoso<CrossWorktreeFile, BaseRowContext>
        data={files}
        context={context}
        customScrollParent={scrollParent}
        computeItemKey={computeBaseRowKey}
        itemContent={renderVirtualizedBaseRow}
        increaseViewportBy={200}
        skipAnimationFrameInResizeObserver
      />
    </div>
  );
}
