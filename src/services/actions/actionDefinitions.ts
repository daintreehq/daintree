import type { ActionCallbacks, ActionRegistry } from "./actionTypes";
import { registerAgentActions } from "./definitions/agentActions";
import { registerAppActions } from "./definitions/appActions";
import { registerBrowserActions } from "./definitions/browserActions";
import { registerDevServerActions } from "./definitions/devServerActions";
import { registerGithubActions } from "./definitions/githubActions";
import { registerGitActions } from "./definitions/gitActions";
import { registerIntrospectionActions } from "./definitions/introspectionActions";
import { registerLogActions } from "./definitions/logActions";
import { registerNavigationActions } from "./definitions/navigationActions";
import { registerNotesActions } from "./definitions/notesActions";
import { registerPanelActions } from "./definitions/panelActions";
import { registerPreferencesActions } from "./definitions/preferencesActions";
import { registerProjectActions } from "./definitions/projectActions";
import { registerRecipeActions } from "./definitions/recipeActions";
import { registerSystemActions } from "./definitions/systemActions";
import { registerTerminalActions } from "./definitions/terminalActions";
import { registerWorktreeActions } from "./definitions/worktreeActions";
import { registerWorktreeSessionActions } from "./definitions/worktreeSessionActions";

export type { ActionCallbacks, ActionRegistry } from "./actionTypes";

export function createActionDefinitions(callbacks: ActionCallbacks): ActionRegistry {
  const actions: ActionRegistry = new Map();

  registerTerminalActions(actions, callbacks);
  registerAgentActions(actions, callbacks);
  registerPanelActions(actions, callbacks);
  registerWorktreeActions(actions, callbacks);
  registerWorktreeSessionActions(actions, callbacks);
  registerRecipeActions(actions, callbacks);
  registerProjectActions(actions, callbacks);
  registerGithubActions(actions, callbacks);
  registerGitActions(actions, callbacks);
  registerSystemActions(actions, callbacks);
  registerLogActions(actions, callbacks);
  registerNavigationActions(actions, callbacks);
  registerAppActions(actions, callbacks);
  registerPreferencesActions(actions, callbacks);
  registerBrowserActions(actions, callbacks);
  registerNotesActions(actions, callbacks);
  registerIntrospectionActions(actions, callbacks);
  registerDevServerActions(actions, callbacks);

  return actions;
}
