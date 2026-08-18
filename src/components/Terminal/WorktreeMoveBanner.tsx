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
      description={
        destinationPath
          ? `Tell it to continue in ${destinationPath}`
          : "The destination worktree is no longer available"
      }
      role="status"
      ariaLive="polite"
      action={{
        id: "tell-agent-worktree-moved",
        label: "Tell the agent",
        onClick: onTell,
        disabled: destinationPath === undefined,
      }}
      onClose={onDismiss}
      closeAriaLabel="Dismiss worktree move notice"
    />
  );
}
