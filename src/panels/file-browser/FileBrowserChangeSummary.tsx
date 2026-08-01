import { cn } from "@/lib/utils";
import { getGitStatusPresentation } from "@/lib/gitStatusPresentation";
import { getWorkingTreeChangeKey, type WorkingTreeFileChange } from "@/lib/workingTreeDiff";

export interface FileBrowserChangeSummaryProps {
  /**
   * The worktree's changed files, already churn-sorted, with paths relative to
   * the worktree root — the same strings the tree's rows and the pane's
   * selection use.
   */
  changes: readonly WorkingTreeFileChange[];
  /**
   * Opens the file in the viewer beside the tree. Never a diff: that is what
   * `worktree.openChanges` is for, and this pane exists to *read* the file an
   * agent just touched.
   */
  onSelect: (relativePath: string) => void;
}

function splitPath(filePath: string): { dir: string; base: string } {
  const cut = filePath.lastIndexOf("/");
  return cut === -1
    ? { dir: "", base: filePath }
    : { dir: filePath.slice(0, cut), base: filePath.slice(cut + 1) };
}

/**
 * What the browser shows when nothing is selected: the answer to "what did the
 * agent just change in here". Fills the pane rather than centring a placeholder
 * in it, because on a dirty worktree this is the pane's primary content.
 */
export function FileBrowserChangeSummary({ changes, onSelect }: FileBrowserChangeSummaryProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-4 pb-2 pt-4">
        <h2 className="text-sm font-medium text-daintree-text">Changed files</h2>
        <p className="mt-0.5 text-xs text-daintree-text/60">Pick a file to read it here</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {changes.map((change) => {
          const presentation = getGitStatusPresentation(change.status);
          // A deleted file has nothing on disk to read. It stays listed — the
          // summary would be lying about the change set otherwise — but it does
          // not pretend to be openable: activating it would land the viewer on a
          // file-not-found error with no way back to what went wrong.
          const isReadable = change.status !== "deleted";
          const { dir, base } = splitPath(change.relativePath);
          const insertions = change.insertions ?? 0;
          const deletions = change.deletions ?? 0;

          return (
            <li key={getWorkingTreeChangeKey(change)}>
              <button
                type="button"
                // aria-disabled rather than `disabled`: the row keeps its place
                // in the tab order so a keyboard user can reach the explanation
                // instead of the row silently not existing for them.
                aria-disabled={!isReadable}
                aria-label={
                  isReadable
                    ? `Read ${change.relativePath}, ${presentation.name}`
                    : `${change.relativePath}, deleted file isn't available to read`
                }
                title={isReadable ? change.relativePath : "Deleted file isn't available to read"}
                onClick={
                  isReadable
                    ? () => {
                        onSelect(change.relativePath);
                      }
                    : undefined
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs",
                  "transition-colors duration-150 ease-out",
                  isReadable
                    ? "cursor-pointer text-daintree-text/80 hover:bg-tint/5 hover:text-daintree-text"
                    : "cursor-default text-daintree-text/40"
                )}
              >
                <span
                  className={cn("w-3 shrink-0 text-center font-bold", presentation.colorClass)}
                  aria-hidden="true"
                >
                  {presentation.marker}
                </span>
                <span className="flex min-w-0 flex-1 items-center">
                  {dir !== "" && <span className="truncate text-daintree-text/50">{dir}/</span>}
                  <span className="truncate font-medium">{base}</span>
                </span>
                <span
                  className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums"
                  aria-hidden="true"
                >
                  {insertions > 0 && <span className="text-status-success/80">+{insertions}</span>}
                  {deletions > 0 && <span className="text-status-error/80">-{deletions}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
