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

/** The diff rows the surface reveals one by one; a scene steps through them with `useTimelineIndex`. */
export const REVIEW_DIFF: ReadonlyArray<{ kind: DiffKind; width: number }> = [
  { kind: "context", width: 62 },
  { kind: "context", width: 48 },
  { kind: "delete", width: 70 },
  { kind: "insert", width: 76 },
  { kind: "insert", width: 58 },
  { kind: "insert", width: 84 },
  { kind: "context", width: 40 },
  { kind: "insert", width: 66 },
  { kind: "context", width: 52 },
];

const DIFF_ROW: Record<DiffKind, string> = {
  context: "bg-transparent",
  insert: "bg-diff-insert-background",
  delete: "bg-diff-delete-background",
};

/**
 * Review Hub over the grid: the worktree's changed files, the diff of the
 * first, and the commit bar. Cue reads stay in the scene, which hands in where
 * the timeline is and the typed message.
 */
export function ReviewHub({
  visible,
  branch,
  files,
  diffStep,
  message,
  pushed,
}: {
  visible: boolean;
  branch: string;
  files: readonly ReviewFile[];
  diffStep: number;
  /** The commit message as typed so far; null shows the placeholder. */
  message: ReactNode;
  pushed: boolean;
}) {
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
              className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-150 ease-out",
                i === 0 && diffStep >= 0 ? "bg-overlay-selected" : "bg-transparent"
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
          {REVIEW_DIFF.map((row, i) => (
            <div
              key={i}
              className={cn(
                "flex h-3.5 items-center rounded-sm px-1.5 transition-opacity duration-150 ease-out",
                DIFF_ROW[row.kind],
                i <= diffStep ? "opacity-100" : "opacity-0"
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
    </div>
  );
}
