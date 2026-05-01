import type { ActionCallbacks, ActionRegistry } from "./actionTypes";
import { registerActionActions } from "./definitions/actionActions";
import { registerAgentActions } from "./definitions/agentActions";
import { registerFileActions } from "./definitions/fileActions";
import { registerAppActions } from "./definitions/appActions";
import { registerBrowserActions } from "./definitions/browserActions";
import { registerDevServerActions } from "./definitions/devServerActions";
import { registerEnvActions } from "./definitions/envActions";
import { registerGithubActions } from "./definitions/githubActions";
import { registerGitActions } from "./definitions/gitActions";
import { registerIntrospectionActions } from "./definitions/introspectionActions";
import { registerLogActions } from "./definitions/logActions";
import { registerNavigationActions } from "./definitions/navigationActions";
import { registerPanelActions } from "./definitions/panelActions";
import { registerPreferencesActions } from "./definitions/preferencesActions";
import { registerProjectActions } from "./definitions/projectActions";
import { registerRecipeActions } from "./definitions/recipeActions";
import { registerSystemActions } from "./definitions/systemActions";
import { registerTerminalQueryActions } from "./definitions/terminalQueryActions";
import { registerTerminalSpawnActions } from "./definitions/terminalSpawnActions";
import { registerTerminalLifecycleActions } from "./definitions/terminalLifecycleActions";
import { registerTerminalNavigationActions } from "./definitions/terminalNavigationActions";
import { registerTerminalLayoutActions } from "./definitions/terminalLayoutActions";
import { registerTerminalInputActions } from "./definitions/terminalInputActions";
import { registerTerminalWorktreeActions } from "./definitions/terminalWorktreeActions";
import { registerFleetActions } from "./definitions/fleetActions";
import { registerVoiceActions } from "./definitions/voiceActions";
import { registerWorktreeActions } from "./definitions/worktreeActions";
import { registerWorktreeSessionActions } from "./definitions/worktreeSessionActions";
import { registerWorkflowActions } from "./definitions/workflowActions";

export type { ActionCallbacks, ActionRegistry } from "./actionTypes";

export function createActionDefinitions(
  callbacks: ActionCallbacks,
  actions?: ActionRegistry
): ActionRegistry {
  actions ??= new Map();

  registerTerminalQueryActions(actions, callbacks);
  registerTerminalSpawnActions(actions, callbacks);
  registerTerminalLifecycleActions(actions, callbacks);
  registerTerminalNavigationActions(actions, callbacks);
  registerTerminalLayoutActions(actions, callbacks);
  registerTerminalInputActions(actions, callbacks);
  registerTerminalWorktreeActions(actions, callbacks);
  registerFleetActions(actions);
  registerAgentActions(actions, callbacks);
  registerPanelActions(actions, callbacks);
  registerWorktreeActions(actions, callbacks);
  registerWorktreeSessionActions(actions, callbacks);
  registerRecipeActions(actions, callbacks);
  registerProjectActions(actions, callbacks);
  registerEnvActions(actions, callbacks);
  registerGithubActions(actions, callbacks);
  registerGitActions(actions, callbacks);
  registerSystemActions(actions, callbacks);
  registerLogActions(actions, callbacks);
  registerNavigationActions(actions, callbacks);
  registerAppActions(actions, callbacks);
  registerPreferencesActions(actions, callbacks);
  registerBrowserActions(actions, callbacks);
  registerIntrospectionActions(actions, callbacks);
  registerDevServerActions(actions, callbacks);
  registerWorkflowActions(actions);
  registerFileActions(actions, callbacks);
  registerVoiceActions(actions);
  registerActionActions(actions);

  return actions;
}
