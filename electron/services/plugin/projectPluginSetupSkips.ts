import { store } from "../../store.js";

/**
 * Each project's skipped plugin setup steps (#13824): plugin instance id → the
 * `contributes.setup` step ids the user chose to skip there. The only setup
 * state the host keeps — whether a step is done is always worked out afresh.
 *
 * Daintree's own settings, never the repository, so a project plugin cannot
 * ship its own steps pre-skipped. A plugin whose steps change keeps the skips
 * that still name one; the rest are dropped on the next write.
 *
 * No in-memory copy: reads happen when a setup strip or checklist loads, and
 * writes on a click.
 */
const STORE_KEY = "projectPluginSetupSkips";

/** Longest plugin instance id a key may be; matches the hidden launch groups bound. */
const MAX_PLUGIN_ID_LENGTH = 300;

/** Longest step id, as the manifest schema allows. */
const MAX_STEP_ID_LENGTH = 64;

/** Most skips one plugin may hold, as the manifest caps its steps. */
const MAX_SKIPS_PER_PLUGIN = 10;

function isStepId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_STEP_ID_LENGTH;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The file is user-editable, so anything that isn't a well-formed step id is skipped. */
function parseSkips(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (isStepId(id)) ids.add(id);
    if (ids.size >= MAX_SKIPS_PER_PLUGIN) break;
  }
  return [...ids];
}

function readAll(): Record<string, unknown> {
  return asRecord(store.get(STORE_KEY) as unknown);
}

/** The step ids `pluginId`'s user skipped in `projectId`. */
export function getProjectPluginSetupSkips(projectId: string, pluginId: string): string[] {
  return parseSkips(asRecord(readAll()[projectId])[pluginId]);
}

/**
 * Skip or restore one step of `pluginId` in `projectId`, keeping only skips
 * that name one of `liveStepIds`. Returns whether anything was written.
 */
export function setProjectPluginSetupStepSkipped(
  projectId: string,
  pluginId: string,
  stepId: string,
  skipped: boolean,
  liveStepIds: readonly string[]
): boolean {
  if (pluginId.length === 0 || pluginId.length > MAX_PLUGIN_ID_LENGTH) {
    throw new Error("setup step: malformed plugin id");
  }
  if (!isStepId(stepId)) throw new Error("setup step: malformed step id");
  const all = readAll();
  const byPlugin = asRecord(all[projectId]);
  const current = parseSkips(byPlugin[pluginId]);
  const live = new Set(liveStepIds);
  const kept = current.filter((id) => live.has(id) && id !== stepId);
  const next = skipped ? [...kept, stepId] : kept;
  if (next.length === current.length && next.every((id) => current.includes(id))) return false;

  const updatedProject = { ...byPlugin };
  if (next.length === 0) delete updatedProject[pluginId];
  else updatedProject[pluginId] = next;
  const updated = { ...all };
  if (Object.keys(updatedProject).length === 0) delete updated[projectId];
  else updated[projectId] = updatedProject;
  store.set(STORE_KEY, updated);
  return true;
}
