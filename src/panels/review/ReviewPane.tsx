import { useCallback, useState } from "react";
import { GitPullRequest } from "lucide-react";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { ReviewHubContent } from "@/components/Worktree/ReviewHub/ReviewHubContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { usePanelRootFocus } from "@/components/Panel/usePanelRootFocus";
import type { PanelLocation } from "@shared/types/panel";

export interface ReviewPaneProps {
  id: string;
  worktreeId?: string;
  onClose: (force?: boolean) => void;
  isFocused?: boolean;
  location?: PanelLocation;
}

export function ReviewPane({
  id,
  worktreeId,
  onClose,
  isFocused = false,
  location = "grid",
}: ReviewPaneProps) {
  const isDialog = location === "dialog";

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

  // Review renders no ContentPanel, so it owns its focus target instead of
  // inheriting ContentPanel's. The getter changes identity with the element,
  // which re-arms the reactive focus once the container commits.
  //
  // Disabled in a dialog: AppDialog owns the focus trap there, and the focus
  // registry is last-writer-wins — a dialog-presented review registering for
  // the same panel id would clobber the grid instance's handler.
  const getContainer = useCallback(() => containerEl, [containerEl]);
  usePanelRootFocus({ id, isFocused, getNode: getContainer, enabled: !isDialog });

  // Resolve worktree path fresh from the worktree store so renames/moves are
  // reflected without restarting the panel. Missing worktreeId yields an empty
  // state instead of an IPC call with an empty path.
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
    )
  );

  // Open-time hints live on the panel record rather than props: the dialog host
  // renders every kind through one fixed prop surface, so the opener passes
  // them via `openPanelDialog` options instead.
  const initialCommitMessage = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "review" ? panel.initialCommitMessage : undefined;
      },
      [id]
    )
  );
  const autoStageOnOpen = usePanelStore(
    useCallback(
      (state) => {
        const panel = state.panelsById[id];
        return panel?.kind === "review" ? panel.autoStageOnOpen === true : false;
      },
      [id]
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
    // Review is the one built-in kind that renders no ContentPanel, so it
    // carries that root's sizing contract itself: `h-full` for the block-level
    // grid/dock wrappers, `flex-1 min-h-0` for the dialog body's flex column
    // (see the same pairing in ContentPanel, #11254).
    <div
      ref={setContainerEl}
      tabIndex={-1}
      className="flex h-full min-h-0 w-full flex-1 flex-col bg-daintree-bg"
    >
      <ReviewHubContent
        isOpen={true}
        panelId={id}
        location={location}
        worktreePath={worktreePath}
        onClose={handleContentClose}
        keyboardScope={containerEl ?? undefined}
        initialCommitMessage={initialCommitMessage}
        // Auto-stage is an opening behaviour of the dialog entry point. Gating
        // it on the dialog location keeps a promoted or restored grid panel
        // from replaying the stage when it remounts under a new host.
        autoStageOnOpen={isDialog && autoStageOnOpen}
      />
    </div>
  );
}
