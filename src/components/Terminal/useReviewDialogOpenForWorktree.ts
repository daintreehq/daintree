import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore } from "@/store/panelDialogStore";

/**
 * Whether a review surface is currently presented as a dialog for `worktreeId`.
 *
 * Replaces the `daintree:open-review-hub` window event that terminal panes used
 * to listen for. That event carried two unrelated jobs — open the hub, and
 * dismiss sibling completion banners — so removing the bespoke open path also
 * removed the dismissal signal. Deriving it from the store is the more honest
 * version anyway: the banner reacts to the review actually being open rather
 * than to someone having asked for it (a refused or superseded open no longer
 * dismisses anything).
 *
 * Both stores are consulted because `openPanelDialog` publishes its id before
 * `addPanel` commits the record — reading the stack alone would report an open
 * review during that in-flight window, for whichever worktree happened to
 * match last.
 */
export function useReviewDialogOpenForWorktree(worktreeId: string | undefined): boolean {
  const dialogStack = usePanelDialogStore((state) => state.dialogStack);
  const panelsById = usePanelStore((state) => state.panelsById);

  if (!worktreeId) return false;

  return dialogStack.some((panelId) => {
    const panel = panelsById[panelId];
    return panel?.kind === "review" && panel.worktreeId === worktreeId;
  });
}
