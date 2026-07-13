import { useCallback, useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { ReviewHubContent } from "@/components/Worktree/ReviewHub/ReviewHubContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { registerPanelFocusHandler } from "@/components/Panel/panelFocusRegistry";

export interface ReviewPaneProps {
  id: string;
  worktreeId?: string;
  onClose: (force?: boolean) => void;
}

export function ReviewPane({ id, worktreeId, onClose }: ReviewPaneProps) {
  // ReviewHubContent wires its Close button as `onClick={onClose}`, so React
  // would hand the MouseEvent straight through as `force` — a truthy object
  // that routes the panel handler to permanent removal instead of the
  // recoverable trash. Drop the argument here.
  const handleContentClose = useCallback(() => onClose(), [onClose]);

  // Callback ref via useState so React re-renders once the container element
  // commits to the DOM. A plain useRef would freeze `current` at `null` for
  // the lifetime of the first render and `keyboardScope` would never receive
  // the element — `ReviewHubContent` would fall back to a document-scoped
  // Escape listener that swallows the key across the whole app.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);

  // Review renders no ContentPanel, so it registers its own focus target
  // instead of inheriting ContentPanel's.
  useEffect(() => {
    if (!containerEl) return undefined;
    return registerPanelFocusHandler(id, () => {
      containerEl.focus({ preventScroll: true });
      return document.activeElement === containerEl;
    });
  }, [id, containerEl]);

  // Resolve worktree path fresh from the worktree store so renames/moves are
  // reflected without restarting the panel. Missing worktreeId yields an empty
  // state instead of an IPC call with an empty path.
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
    )
  );

  if (!worktreePath) {
    return (
      <div
        ref={setContainerEl}
        tabIndex={-1}
        className="flex h-full w-full items-center justify-center"
      >
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<GitPullRequest className="h-6 w-6" />}
          title="Worktree unavailable"
          description="Open a worktree to review and commit changes."
        />
      </div>
    );
  }

  return (
    <div ref={setContainerEl} tabIndex={-1} className="flex h-full w-full flex-col bg-daintree-bg">
      <ReviewHubContent
        isOpen={true}
        worktreePath={worktreePath}
        onClose={handleContentClose}
        keyboardScope={containerEl ?? undefined}
      />
    </div>
  );
}
