import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { registerWorktreeQueryActions } from "./worktreeQueryActions";
import { registerWorktreeServiceActions } from "./worktreeServiceActions";
import { registerWorktreeCreateActions } from "./worktreeCreateActions";
import { registerWorktreeNavigationActions } from "./worktreeNavigationActions";
import { registerWorktreeContextActions } from "./worktreeContextActions";
import { registerWorktreeGitHubActions } from "./worktreeGitHubActions";
import { registerWorktreeResourceActions } from "./worktreeResourceActions";

export function registerWorktreeActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  registerWorktreeQueryActions(actions, callbacks);
  registerWorktreeServiceActions(actions, callbacks);
  registerWorktreeCreateActions(actions, callbacks);
  registerWorktreeNavigationActions(actions, callbacks);
  registerWorktreeContextActions(actions, callbacks);
  registerWorktreeGitHubActions(actions, callbacks);
  registerWorktreeResourceActions(actions, callbacks);
}
