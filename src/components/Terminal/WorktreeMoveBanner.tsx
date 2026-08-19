import { FolderGit2 } from "@/components/icons";
import { InlineStatusBanner } from "./InlineStatusBanner";

export interface WorktreeMoveBannerProps {
  /** Destination path, or `undefined` when the worktree has since gone. */
  destinationPath: string | undefined;
  onTell: () => void;
  onDismiss: () => void;
}

/**
 * The whole of #11853's replacement for the #11840 decision dialog: an amber
 * bar in the pane with two outcomes and no third option.
 *
 * "may" is load-bearing in the title. A launch-root mismatch is provable; what
 * the agent has done about it is not — it can be told to work elsewhere and
 * comply completely while `panel.cwd` still names the directory it started in.
 * Claiming more than that is what made the old persistent marker wrong.
 *
 * One action plus the built-in close, not two buttons: the X *is* the dismiss,
 * and spelling it twice would put three controls in front of two outcomes.
 *
 * The action *is* the sentence rather than a button beside it (#11868). A boxed
 * banner action draws its fill from `bg-daintree-border`, the one surface the
 * amber wash renders indistinct — the neutral label was always legible, the box
 * around it was not. Dropping the box and underlining the label keeps the same
 * text colour, so nothing new has to be mixed over a composited tint, and it
 * follows `TerminalCountWarning`, the other warning bar whose sole control
 * lives in `descriptionExtras`.
 *
 * With no destination there is nothing to tell, so the control is absent rather
 * than present-but-disabled: the sentence explains why, and the X still works.
 */
export function WorktreeMoveBanner({
  destinationPath,
  onTell,
  onDismiss,
}: WorktreeMoveBannerProps) {
  return (
    <InlineStatusBanner
      icon={FolderGit2}
      severity="warning"
      title="Agent may still be in the original worktree"
      description={destinationPath ? undefined : "The destination worktree is no longer available"}
      descriptionExtras={
        destinationPath ? (
          <button
            type="button"
            onClick={(e) => {
              // The pane focuses itself from a click handler above every banner
              // slot. Telling the agent must not also pull focus into the
              // terminal the user just clicked past.
              e.stopPropagation();
              onTell();
            }}
            className="-ml-1 mt-0.5 inline-block max-w-full cursor-pointer rounded-sm px-1 py-0.5 text-left text-xs font-medium whitespace-normal break-words text-daintree-text underline underline-offset-4 outline-hidden transition-[background-color] duration-150 ease-out hover:bg-overlay-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent"
          >
            Tell it to continue in {destinationPath}
          </button>
        ) : undefined
      }
      role="status"
      ariaLive="polite"
      onClose={onDismiss}
      closeAriaLabel="Dismiss worktree move notice"
    />
  );
}
