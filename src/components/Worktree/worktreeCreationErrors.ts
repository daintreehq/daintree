import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export interface WorktreeCreationError {
  friendly: string;
  raw: string;
  recovery?: {
    label: string;
    onAction: () => void;
  };
}

export function mapCreationError(rawMessage: string, onClose?: () => void): WorktreeCreationError {
  if (rawMessage.includes("already checked out")) {
    let recovery: WorktreeCreationError["recovery"] | undefined;
    try {
      const pathMatch = rawMessage.match(/already checked out at '([^']+)'/);
      const worktreePath = pathMatch?.[1];
      if (worktreePath) {
        recovery = {
          label: "Open Worktree",
          onAction: () => {
            const worktrees = useWorktreeDataStore.getState().getWorktreeList();
            const wt = worktrees.find((w) => w.path === worktreePath);
            if (wt) {
              useWorktreeSelectionStore.getState().selectWorktree(wt.id);
              onClose?.();
            }
          },
        };
      }
    } catch {
      // Regex parsing failed — fall through without recovery
    }
    return {
      friendly: "This branch is already open in another worktree.",
      raw: rawMessage,
      recovery,
    };
  }

  if (rawMessage.includes("could not create work tree dir")) {
    return {
      friendly: "Cannot create directory — check permissions or available disk space.",
      raw: rawMessage,
    };
  }

  if (rawMessage.includes("not a valid branch name")) {
    return {
      friendly: "The branch name contains invalid characters.",
      raw: rawMessage,
    };
  }

  if (rawMessage.includes("already exists") && rawMessage.includes("work tree")) {
    return {
      friendly: "A worktree already exists at this path.",
      raw: rawMessage,
    };
  }

  return { friendly: rawMessage, raw: rawMessage };
}
