import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

import { useOverlayState } from "@/hooks";
import { ReviewHubContent } from "./ReviewHubContent";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";

interface ReviewHubProps {
  isOpen: boolean;
  worktreePath: string;
  onClose: () => void;
  /**
   * Seed value for the commit message on open. Used by the worktree card to
   * prefill the AI-note first line; the user can still edit or clear it.
   */
  initialCommitMessage?: string;
  /**
   * When true, stage all unstaged files on open if there are no staged files
   * yet. Mirrors the prior `CommitComposerDialog` "quick commit" path: opening
   * the hub from the worktree card should result in a ready-to-commit state.
   */
  autoStageOnOpen?: boolean;
}

/**
 * Modal-mounted Review & Commit surface. Owns only the chrome (backdrop,
 * portal, focus init, overlay registration) — all staging state, IPC, and
 * interactions live in `ReviewHubContent` so the same body can later be
 * mounted in a non-modal container (e.g., a future review panel kind)
 * without dragging the portal/overlay wrapper with it.
 */
export function ReviewHub({
  isOpen,
  worktreePath,
  onClose,
  initialCommitMessage,
  autoStageOnOpen,
}: ReviewHubProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useOverlayState(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      if (dialogRef.current && !dialogRef.current.contains(document.activeElement)) {
        dialogRef.current.focus();
      }
    });
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center",
        "bg-scrim-medium backdrop-blur-sm",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-hub-title"
      data-testid="review-hub"
    >
      <div
        ref={dialogRef}
        className={cn(
          "relative flex flex-col",
          "w-[min(720px,calc(100vw-80px))] max-h-[calc(100vh-80px)] min-h-[320px]",
          "bg-daintree-bg rounded-xl",
          "border border-divider",
          "shadow-[var(--theme-shadow-dialog)]",
          "motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200",
          "outline-hidden overflow-hidden"
        )}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <ReviewHubContent
          isOpen={isOpen}
          worktreePath={worktreePath}
          onClose={onClose}
          initialCommitMessage={initialCommitMessage}
          autoStageOnOpen={autoStageOnOpen}
        />
        {/* Co-located live region: ForcePushConfirmDialog and other nested
            flows close their inner dialog before announcing, returning focus
            to this modal. VoiceOver suppresses external `aria-live` updates
            outside this `aria-modal` subtree when `document.ariaNotify` is
            unavailable (Chromium 354736464). */}
        <AccessibilityAnnouncer />
      </div>
    </div>,
    document.body
  );
}
