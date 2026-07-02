import type { ActionCallbacks, ActionRegistry } from "./actionTypes";
import { registerActionActions } from "./definitions/actionActions";
import { registerAgentActions } from "./definitions/agentActions";
import { registerFileActions } from "./definitions/fileActions";
import { registerAppActions } from "./definitions/appActions";
import { registerBrowserActions } from "./definitions/browserActions";
import { registerDevPreviewActions } from "./definitions/devPreviewActions";
import { registerDevServerActions } from "./definitions/devServerActions";
import { registerDiagnosticsActions } from "./definitions/diagnosticsActions";
import { registerEnvActions } from "./definitions/envActions";
import { registerForgeActions } from "./definitions/forgeActions";
import { registerGitActions } from "./definitions/gitActions";
import { registerIntrospectionActions } from "./definitions/introspectionActions";
import { registerLogActions } from "./definitions/logActions";
import { registerNavigationActions } from "./definitions/navigationActions";
import { registerNotificationsActions } from "./definitions/notificationsActions";
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
import { registerWatchdogActions } from "./definitions/watchdogActions";
import { registerWorktreeActions } from "./definitions/worktreeActions";
import { registerWorktreeSessionActions } from "./definitions/worktreeSessionActions";
import { registerWorktreeBulkActions } from "./definitions/worktreeBulkActions";
import { registerWorkflowActions } from "./definitions/workflowActions";
import { registerSkillActions } from "./definitions/skillActions";

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
  registerWorktreeBulkActions(actions);
  registerRecipeActions(actions, callbacks);
  registerProjectActions(actions, callbacks);
  registerEnvActions(actions, callbacks);
  registerForgeActions(actions, callbacks);
  registerGitActions(actions, callbacks);
  registerSystemActions(actions, callbacks);
  registerSkillActions(actions, callbacks);
  registerWatchdogActions(actions);
  registerLogActions(actions, callbacks);
  registerNavigationActions(actions, callbacks);
  registerNotificationsActions(actions);
  registerAppActions(actions, callbacks);
  registerPreferencesActions(actions, callbacks);
  registerBrowserActions(actions, callbacks);
  registerIntrospectionActions(actions, callbacks);
  registerDevServerActions(actions, callbacks);
  registerDevPreviewActions(actions, callbacks);
  registerDiagnosticsActions(actions, callbacks);
  registerWorkflowActions(actions, callbacks);
  registerFileActions(actions, callbacks);
  registerVoiceActions(actions);
  registerActionActions(actions);

  return actions;
}
