import type React from "react";
import { cn } from "@/lib/utils";
import { DiffStat } from "@/components/ui/DiffStat";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PathTail } from "@/components/ui/PathTail";
import { getGitStatusPresentation } from "@/lib/gitStatusPresentation";
import { getWorkingTreeChangeKey, type WorkingTreeFileChange } from "@/lib/workingTreeDiff";
import { PALETTE_ROW_FOCUS_CLASS, ROW_MENU_TARGET_CLASS } from "@/components/ui/paletteRowStyles";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  isFileRowMenuKey,
  openFileRowMenuFromKeyboard,
  stopFileRowMenuPropagation,
} from "@/hooks/useFileRowMenuItems";

export interface FileBrowserChangeSummaryProps {
  /**
   * The worktree's changed files, already churn-sorted, with paths relative to
   * the worktree root — the same strings the tree's rows and the pane's
   * selection use.
   */
  changes: readonly WorkingTreeFileChange[];
  /**
   * Opens the file in the viewer beside the tree, in whatever mode the reader
   * last chose there. A changed file's viewer offers a Diff segment beside
   * Source, so the file's own diff is one click away without leaving the pane.
   */
  onSelect: (relativePath: string) => void;
  /**
   * The file menu for one row — the shared `useFileRowMenuItems` core, built by
   * the pane that owns the hook so the summary never mints a subscription of
   * its own. Deleted rows get one too: their diff and path copies still apply.
   */
  changeContextMenu?: ((change: WorkingTreeFileChange) => React.ReactNode) | undefined;
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
export function FileBrowserChangeSummary({
  changes,
  onSelect,
  changeContextMenu,
}: FileBrowserChangeSummaryProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-4 pb-2 pt-4">
        <h2 className="text-sm font-medium text-text-primary">Changed files</h2>
        <p className="mt-0.5 text-xs text-text-secondary">Pick a file to read it here</p>
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
          const menuItems = changeContextMenu?.(change) ?? null;

          return (
            <li key={getWorkingTreeChangeKey(change)}>
              {/* `ContextMenuTrigger` wraps `TooltipTrigger`, not the other way
                  round: both write `data-state` onto the merged row and the
                  outer one wins, which has to be the menu's — the open-row ring
                  reads it. Same order as `FileChangeList`. */}
              <ContextMenu>
                <Tooltip>
                  <ContextMenuTrigger
                    asChild
                    disabled={!menuItems}
                    onContextMenu={menuItems ? stopFileRowMenuPropagation : undefined}
                  >
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        // aria-disabled rather than `disabled`: the row keeps its place
                        // in the tab order so a keyboard user can reach the explanation
                        // instead of the row silently not existing for them.
                        aria-disabled={!isReadable}
                        // Stands the global Shift+F10 / Menu-key handler down so the
                        // row's own handler opens this file's menu, not the panel's.
                        {...(menuItems ? { "data-row-menu": "" } : {})}
                        onKeyDown={
                          menuItems
                            ? (event) => {
                                if (!isFileRowMenuKey(event)) return;
                                event.preventDefault();
                                event.stopPropagation();
                                openFileRowMenuFromKeyboard(event.currentTarget);
                              }
                            : undefined
                        }
                        aria-label={
                          isReadable
                            ? `Read ${change.relativePath}, ${presentation.name}`
                            : `${change.relativePath}, deleted file isn't available to read`
                        }
                        onClick={
                          isReadable
                            ? () => {
                                onSelect(change.relativePath);
                              }
                            : undefined
                        }
                        className={cn(
                          "flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2 py-1 text-left text-xs",
                          "transition-colors duration-150 ease-out",
                          // Unconditional: a deleted file's row stays in the tab order
                          // (aria-disabled, so the explanation can be read), and a
                          // focusable row without a ring takes the browser's default.
                          PALETTE_ROW_FOCUS_CLASS,
                          ROW_MENU_TARGET_CLASS,
                          isReadable
                            ? "cursor-pointer text-text-secondary hover:bg-overlay-subtle hover:text-text-primary"
                            : // Struck through rather than faded: the row stays readable
                              // at full strength while still saying there is nothing
                              // left to open — the convention source-control lists use
                              // for a deleted path.
                              "cursor-default text-text-secondary line-through decoration-text-secondary"
                        )}
                      >
                        <span
                          className={cn(
                            "w-3 shrink-0 text-center font-bold",
                            presentation.colorClass
                          )}
                          aria-hidden="true"
                        >
                          {presentation.marker}
                        </span>
                        <span className="flex min-w-0 flex-1 items-center">
                          {dir !== "" && (
                            <PathTail className="text-text-secondary">{`${dir}/`}</PathTail>
                          )}
                          <span
                            className={cn(
                              "truncate font-medium",
                              isReadable && "text-text-primary"
                            )}
                          >
                            {base}
                          </span>
                        </span>
                        <DiffStat
                          insertions={insertions}
                          deletions={deletions}
                          className="shrink-0 text-2xs"
                          aria-hidden="true"
                        />
                      </button>
                    </TooltipTrigger>
                  </ContextMenuTrigger>
                  <TooltipContent side="top">
                    {isReadable ? change.relativePath : "Deleted file isn't available to read"}
                  </TooltipContent>
                </Tooltip>
                {menuItems && <ContextMenuContent>{menuItems}</ContextMenuContent>}
              </ContextMenu>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
