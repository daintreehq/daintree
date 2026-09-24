import { FolderGit2 } from "@/components/icons";
import { buildWorktreeMoveInstruction } from "@/services/terminal/worktreeMoveInstruction";
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
 * The whole of #11853's replacement for the #11840 decision dialog: a one-line
 * notice in the pane with two outcomes and no third option.
 *
 * "may" is load-bearing in the title. A launch-root mismatch is provable; what
 * the agent has done about it is not — it can be told to work elsewhere and
 * comply completely while `panel.cwd` still names the directory it started in.
 * Claiming more than that is what made the old persistent marker wrong.
 *
 * One action plus the built-in close, not two buttons: the X *is* the dismiss,
 * and spelling it twice would put three controls in front of two outcomes.
 *
 * It uses the `inline` layout because moving agent panes is routine and this
 * shows up every time: one row, the action and the X straight after the
 * sentence rather than across the pane, and no amber band. The action says
 * "here" rather than printing the destination — the pane already lives in that
 * worktree — and the tooltip carries the exact sentence it will type, path
 * included, for anyone who wants to check before sending.
 *
 * With no destination there is nothing to tell, so the control is absent rather
 * than present-but-disabled: the sentence explains why, and the X still works.
 *
 * A failed delivery turns the notice red and into an alert rather than raising
 * a toast: the signal and its recovery both live here, and the notice is
 * already on screen. The user asked for something and it did not happen, which
 * is worth interrupting for. It does not guess at why — a lock, a restart, a
 * fleet arming mid-send and a stale notice all land here alike.
 */
export function WorktreeMoveBanner({
  destinationPath,
  deliveryFailed = false,
  onTell,
  onDismiss,
}: WorktreeMoveBannerProps) {
  const description =
    destinationPath === undefined ? "Its new worktree no longer exists" : undefined;

  return (
    <InlineStatusBanner
      icon={FolderGit2}
      severity={deliveryFailed ? "error" : "warning"}
      layout="inline"
      title={
        deliveryFailed
          ? "The instruction didn't reach the terminal"
          : "Agent may still be in the old worktree"
      }
      description={description}
      action={
        destinationPath
          ? {
              id: "tell",
              label: deliveryFailed ? "Retry" : "Tell it to continue here",
              ariaLabel: deliveryFailed
                ? "Retry telling the agent to continue in this worktree"
                : undefined,
              title: `Sends “${buildWorktreeMoveInstruction(destinationPath)}”`,
              variant: "primary",
              onClick: onTell,
            }
          : undefined
      }
      role={deliveryFailed ? "alert" : "status"}
      ariaLive={deliveryFailed ? undefined : "polite"}
      onClose={onDismiss}
      closeAriaLabel="Dismiss worktree move notice"
    />
  );
}
