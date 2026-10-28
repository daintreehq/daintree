import {
  PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS,
  type PluginWorktreeSetupStepHandler,
  type WorktreeSetupStepContribution,
} from "../../shared/types/plugin.js";

/**
 * Host-side registry of `contributes.worktreeSetupSteps` (#13807), with the
 * same two-map shape as `fileDecorationRegistry.ts`: descriptors register
 * eagerly from each plugin's manifest during `loadPlugin`, so a project's step
 * list — and what the user is asked to allow — is known before any plugin code
 * runs, while handlers bind lazily during `activate()` through
 * `host.registerWorktreeSetupStep`. A descriptor with no handler is not an
 * error here: the plugin may not have activated yet.
 */

/** One declared step, with what the user is shown and asked to allow. */
export interface RegisteredWorktreeSetupStep {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  stepId: string;
  label: string;
  timeoutMs: number;
}

interface PluginSteps {
  pluginName: string;
  pluginVersion: string;
  steps: readonly WorktreeSetupStepContribution[];
}

const PLUGIN_STEPS = new Map<string, PluginSteps>();

const STEP_HANDLERS = new Map<string, PluginWorktreeSetupStepHandler>();

function handlerKey(pluginId: string, stepId: string): string {
  return `${pluginId}\0${stepId}`;
}

export function registerWorktreeSetupSteps(
  pluginId: string,
  meta: { pluginName: string; pluginVersion: string },
  steps: readonly WorktreeSetupStepContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(steps) || steps.length === 0) {
    PLUGIN_STEPS.delete(pluginId);
    return;
  }
  PLUGIN_STEPS.set(pluginId, {
    pluginName: meta.pluginName,
    pluginVersion: meta.pluginVersion,
    steps: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
  });
}

export function unregisterWorktreeSetupSteps(pluginId: string): void {
  PLUGIN_STEPS.delete(pluginId);
}

export function isWorktreeSetupStepDeclared(pluginId: string, stepId: string): boolean {
  return PLUGIN_STEPS.get(pluginId)?.steps.some((step) => step.id === stepId) ?? false;
}

/**
 * Every declared step, in the order they run: by plugin id, then as each
 * manifest declares them. Plugin load order would also be stable within a
 * session, but not across restarts, and the order is part of the contract.
 */
export function getWorktreeSetupSteps(): RegisteredWorktreeSetupStep[] {
  const pluginIds = [...PLUGIN_STEPS.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return pluginIds.flatMap((pluginId) => {
    const entry = PLUGIN_STEPS.get(pluginId)!;
    return entry.steps.map((step) => ({
      pluginId,
      pluginName: entry.pluginName,
      pluginVersion: entry.pluginVersion,
      stepId: step.id,
      label: step.label,
      timeoutMs: step.timeoutMs ?? PLUGIN_WORKTREE_SETUP_STEP_DEFAULT_TIMEOUT_MS,
    }));
  });
}

/**
 * Bind a handler to a declared step. Re-binding the same step overwrites, so
 * a plugin that re-registers picks up the new handler on the next run.
 */
export function registerWorktreeSetupStepHandler(
  pluginId: string,
  stepId: string,
  handler: PluginWorktreeSetupStepHandler
): void {
  STEP_HANDLERS.set(handlerKey(pluginId, stepId), handler);
}

/**
 * Unbind one handler. With `expected`, only when it is still that handler, so
 * a disposer from an overwritten binding cannot remove its replacement.
 */
export function unregisterWorktreeSetupStepHandler(
  pluginId: string,
  stepId: string,
  expected?: PluginWorktreeSetupStepHandler
): void {
  const key = handlerKey(pluginId, stepId);
  if (expected !== undefined && STEP_HANDLERS.get(key) !== expected) return;
  STEP_HANDLERS.delete(key);
}

/** Unbind every handler the plugin bound. Fires from `unloadPlugin`. */
export function unregisterWorktreeSetupStepHandlers(pluginId: string): void {
  const prefix = `${pluginId}\0`;
  for (const key of [...STEP_HANDLERS.keys()]) {
    if (key.startsWith(prefix)) STEP_HANDLERS.delete(key);
  }
}

export function getWorktreeSetupStepHandler(
  pluginId: string,
  stepId: string
): PluginWorktreeSetupStepHandler | undefined {
  return STEP_HANDLERS.get(handlerKey(pluginId, stepId));
}

/** Test isolation. */
export function clearWorktreeSetupStepRegistry(): void {
  PLUGIN_STEPS.clear();
  STEP_HANDLERS.clear();
}
