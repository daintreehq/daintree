import type { ReactNode } from "react";
import { Check, FileCode, GitBranch } from "lucide-react";
import { cn, reveal } from "@daintreehq/tour/kit";
import { GRID_RECT } from "@daintreehq/tour/mock-app";

export interface ReviewFile {
  name: string;
  added: number;
  removed: number;
}

type DiffKind = "context" | "insert" | "delete";

type DiffRow = { kind: DiffKind; width: number };

/** One diff per file, so stepping to the next file visibly changes what's shown. */
const REVIEW_DIFFS: ReadonlyArray<readonly DiffRow[]> = [
  [
    { kind: "context", width: 62 },
    { kind: "context", width: 48 },
    { kind: "delete", width: 70 },
    { kind: "insert", width: 76 },
    { kind: "insert", width: 58 },
    { kind: "insert", width: 84 },
    { kind: "context", width: 40 },
    { kind: "insert", width: 66 },
    { kind: "context", width: 52 },
  ],
  [
    { kind: "context", width: 44 },
    { kind: "delete", width: 58 },
    { kind: "insert", width: 64 },
    { kind: "insert", width: 72 },
    { kind: "context", width: 56 },
    { kind: "context", width: 38 },
    { kind: "insert", width: 80 },
    { kind: "insert", width: 50 },
    { kind: "context", width: 46 },
  ],
];

const DIFF_ROW: Record<DiffKind, string> = {
  context: "bg-transparent",
  insert: "bg-diff-insert-background",
  delete: "bg-diff-delete-background",
};

/**
 * Review Hub over the grid: the worktree's changed files, the diff of the one
 * selected, the commit bar, and the push confirm that Commit & push opens. Cue
 * reads stay in the scene, which hands in where the timeline is and the typed
 * message.
 */
export function ReviewHub({
  visible,
  branch,
  files,
  selected,
  message,
  confirming,
  pushed,
}: {
  visible: boolean;
  branch: string;
  files: readonly ReviewFile[];
  /** The file whose diff is open, or -1 before one is picked. */
  selected: number;
  /** The commit message as typed so far; null shows the placeholder. */
  message: ReactNode;
  /** Commit & push was pressed: the push confirm names where the branch goes. */
  confirming: boolean;
  pushed: boolean;
}) {
  const diff = selected >= 0 ? REVIEW_DIFFS[selected % REVIEW_DIFFS.length]! : [];
  return (
    <div
      className={cn(
        "absolute z-10 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-panel shadow-[var(--theme-shadow-ambient)]",
        reveal(visible)
      )}
      style={{
        left: GRID_RECT.x,
        top: GRID_RECT.y,
        width: GRID_RECT.width,
        height: GRID_RECT.height,
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
        <span className="shrink-0 text-2xs font-semibold text-text-primary">Review Hub</span>
        <span className="flex min-w-0 items-center gap-1 rounded-sm bg-overlay-subtle px-1 font-mono text-3xs text-text-secondary">
          <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{branch}</span>
        </span>
      </div>
      {/* Once pushed nothing is left to commit, so the list and the commit bar
          give way to the clean state, as the real surface does. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center gap-1.5 text-2xs text-text-secondary",
          pushed ? "flex" : "hidden"
        )}
      >
        <Check className="size-3" aria-hidden="true" />
        Working tree clean
      </div>
      <div className={cn("min-h-0 flex-1", pushed ? "hidden" : "flex")}>
        <div className="flex w-[150px] shrink-0 flex-col gap-0.5 border-r border-border-subtle p-1.5">
          <span className="px-1.5 pb-0.5 text-3xs font-semibold text-text-secondary">Staged</span>
          {files.map((file, i) => (
            <div
              key={file.name}
              data-tour-anchor={`review-file-${i}`}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-150 ease-out",
                i === selected ? "bg-overlay-selected" : "bg-transparent"
              )}
            >
              <FileCode className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-3xs text-text-primary">
                {file.name}
              </span>
              {/* DiffStat's spelling, inline: tour scenes can't import host components (#12769). */}
              <span className="inline-flex items-center gap-1 text-3xs tabular-nums">
                {file.added > 0 && <span className="text-diff-text-insert">+{file.added}</span>}
                {file.removed > 0 && <span className="text-diff-text-delete">-{file.removed}</span>}
              </span>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
          {selected >= 0 && (
            <span className="flex h-3 items-center gap-1 text-3xs text-text-secondary">
              <FileCode className="size-2.5" aria-hidden="true" />
              {files[selected]?.name}
            </span>
          )}
          {selected < 0 && (
            <span className="m-auto text-3xs text-text-secondary">
              Select a file to see its diff
            </span>
          )}
          {/* Keyed by file, so each file's diff arrives as its own. */}
          {diff.map((row, i) => (
            <div
              key={`${selected}-${i}`}
              className={cn(
                "flex h-3.5 items-center rounded-sm px-1.5 motion-safe:animate-in motion-safe:fade-in",
                DIFF_ROW[row.kind]
              )}
            >
              <span className="w-3 shrink-0 text-3xs text-text-secondary">
                {row.kind === "insert" ? "+" : row.kind === "delete" ? "−" : ""}
              </span>
              <span
                className="h-1 rounded-full bg-overlay-strong"
                style={{ width: `${row.width}%` }}
              />
            </div>
          ))}
        </div>
      </div>
      <div
        className={cn(
          "shrink-0 items-center gap-2 border-t border-border-subtle p-2",
          pushed ? "hidden" : "flex"
        )}
      >
        <div className="flex h-6 min-w-0 flex-1 items-center rounded-md border border-border-input bg-surface-input px-2 text-3xs">
          {message ?? <span className="text-text-secondary">Commit message…</span>}
        </div>
        <span
          data-tour-anchor="review-commit-push"
          className="flex h-6 items-center gap-1 rounded-md bg-text-primary px-2.5 text-3xs font-medium text-text-inverse"
        >
          Commit &amp; push
        </span>
      </div>
      {/* The push confirm, on by default per worktree: the destination is the point. */}
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-center bg-scrim-soft",
          reveal(confirming && !pushed, "none")
        )}
      >
        <div className="flex w-[260px] flex-col gap-2 rounded-lg border border-border-strong bg-surface-dialog p-3 shadow-[var(--theme-shadow-ambient)]">
          <span className="text-xs font-semibold text-text-primary">Push commits?</span>
          <span className="text-3xs text-text-secondary">
            1 commit, {files.length} files, to{" "}
            <span className="font-mono text-text-primary">origin/{branch}</span>
          </span>
          <div className="flex justify-end gap-1.5">
            <span className="flex h-6 items-center rounded-md px-2.5 text-3xs text-text-secondary">
              Cancel
            </span>
            <span
              data-tour-anchor="review-push-confirm"
              className="flex h-6 max-w-[160px] items-center rounded-md bg-text-primary px-2.5 text-3xs font-medium text-text-inverse"
            >
              <span className="truncate">Push to origin/{branch}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
