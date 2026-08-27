import { FolderGit2 } from "@/components/icons";
import { InlineStatusBanner } from "./InlineStatusBanner";

export interface WorktreeMoveBannerProps {
  /** Destination path, or `undefined` when the worktree has since gone. */
  destinationPath: string | undefined;
  /** A tell was tried and the terminal did not take it (#11867). */
  deliveryFailed?: boolean;
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
 *
 * A failed delivery turns the same bar red rather than raising a toast: the
 * signal and its recovery both live here, and the bar is already on screen.
 * It also stops being a polite status — the user asked for something and it
 * did not happen, which is worth interrupting for. The recovery keeps the
 * sentence shape; the red wash renders a boxed fill no better than the amber
 * one did, and `InlineStatusBanner` types an error banner as taking at most one
 * boxed `action` anyway.
 */
export function WorktreeMoveBanner({
  destinationPath,
  deliveryFailed = false,
  onTell,
  onDismiss,
}: WorktreeMoveBannerProps) {
  const description =
    destinationPath === undefined
      ? "The destination worktree is no longer available"
      : deliveryFailed
        ? "The instruction didn't reach the terminal. Wait until it's connected, unlocked and not restarting, then retry."
        : undefined;

  return (
    <InlineStatusBanner
      icon={FolderGit2}
      severity={deliveryFailed ? "error" : "warning"}
      title={
        deliveryFailed ? "Couldn't tell the agent" : "Agent may still be in the original worktree"
      }
      description={description}
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
            className="-ml-1 mt-0.5 inline-block max-w-full cursor-pointer rounded-sm px-1 py-0.5 text-left text-xs font-medium whitespace-normal break-words text-daintree-text underline underline-offset-4 outline-hidden transition-[background-color] duration-150 ease-out hover:bg-overlay-hover focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent"
          >
            {deliveryFailed ? "Retry telling it to continue in" : "Tell it to continue in"}{" "}
            {destinationPath}
          </button>
        ) : undefined
      }
      role={deliveryFailed ? "alert" : "status"}
      ariaLive={deliveryFailed ? undefined : "polite"}
      onClose={onDismiss}
      closeAriaLabel="Dismiss worktree move notice"
    />
  );
}
