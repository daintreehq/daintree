import { stripAssignedSessionIdArgs, type AddPanelOptions } from "@shared/types";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

/**
 * Narrow the preset environment out of the panel's untyped extension bag.
 * Non-string values are dropped rather than trusted: this feeds a real
 * subprocess environment, where a non-string would stringify into something
 * nobody wrote.
 */
export function readPresetEnv(panel: PtyPanelData): Record<string, string> | undefined {
  const raw = panel.extensionState?.presetEnv;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Rebuild the launch a missing-CLI gate panel stood in for.
 *
 * Single source of truth for which fields survive the "Run anyway" hop, which
 * hands them straight to `addPanel`. `missingCliRelaunchKey` derives gate
 * identity from the same output, so a field added here is automatically carried
 * AND compared instead of drifting out of two hand-maintained lists.
 *
 * The re-check exit does not relaunch through this — it re-dispatches
 * `agent.launch` so the launcher re-resolves the command against the path the
 * probe just found, and so replays only the caller's own choices. See
 * `buildMissingCliContinueArgs`.
 *
 * Returns null when the panel carries no agent, which makes it unrelaunchable.
 */
export function buildMissingCliRelaunchOptions(panel: PtyPanelData): AddPanelOptions | null {
  const agentId = panel.launchAgentId;
  if (!agentId) return null;

  return {
    kind: "terminal",
    launchAgentId: agentId,
    // A per-launch session id would make every gate for the same launch a
    // different one, so repeated clicks would each append another panel
    // instead of reusing the gate. "Run anyway" forwards no id either, so
    // replaying a spent one would only get the relaunch rejected (#11782).
    command: panel.command ? stripAssignedSessionIdArgs(panel.command, agentId) : panel.command,
    title: panel.title,
    // Without this a custom-titled relaunch reverts to detection-driven
    // titling, so the name the user chose is silently overwritten.
    titleMode: panel.titleMode,
    cwd: panel.cwd ?? "",
    worktreeId: panel.worktreeId,
    location: panel.location === "dock" ? "dock" : "grid",
    // A dock replacement that doesn't activate starts parked and offscreen, so
    // the recovery the user just asked for would produce nothing visible. The
    // gate itself is what they were looking at, so the dock is already open.
    activateDockOnCreate: panel.location === "dock" ? true : undefined,
    agentLaunchFlags: panel.agentLaunchFlags,
    agentModelId: panel.agentModelId,
    agentPresetId: panel.agentPresetId,
    // The fallback mark colour when the preset is later deleted — dropping it
    // changes the relaunched pane's chrome, so the continued launch would not be
    // the launch that was originally asked for.
    agentPresetColor: panel.agentPresetColor,
    env: readPresetEnv(panel),
    // Since env is persisted onto the panel (#10922), dropping these would let
    // a session-scoped secret leak into the on-disk snapshot on relaunch.
    excludeFromPersistence: panel.excludeFromPersistence,
    removeOnExit: panel.removeOnExit,
    spawnedBy: panel.spawnedBy,
    focusPolicy: panel.focusPolicy,
  };
}

/** `agent.launch` arguments that continue the launch a gate stood in for. */
export interface MissingCliContinueArgs {
  agentId: string;
  location: "grid" | "dock";
  cwd?: string;
  worktreeId?: string;
  model?: string;
  presetId: string | null;
  activateDockOnCreate?: true;
  env?: Record<string, string>;
  excludeFromPersistence?: boolean;
  removeOnExit?: boolean;
  spawnedBy?: PtyPanelData["spawnedBy"];
  focusPolicy?: PtyPanelData["focusPolicy"];
}

/**
 * Continue a gated launch through the launcher after a re-check found the CLI.
 *
 * Deliberately not the relaunch options above: this exit re-dispatches
 * `agent.launch`, so the launcher rebuilds the command, the flag set and the
 * title against the freshly resolved path. Only what the original caller chose
 * is replayed — forwarding the gate's already-resolved `agentLaunchFlags` would
 * append them a second time on top of the set the launcher rebuilds, and its
 * title is recomposed from the same agent, preset and model.
 *
 * Returns null when the panel carries no agent, which makes it unrelaunchable.
 */
export function buildMissingCliContinueArgs(panel: PtyPanelData): MissingCliContinueArgs | null {
  const agentId = panel.launchAgentId;
  if (!agentId) return null;

  const location = panel.location === "dock" ? "dock" : "grid";
  return {
    agentId,
    location,
    cwd: panel.cwd,
    worktreeId: panel.worktreeId,
    model: panel.agentModelId,
    // Explicit null preserves a deliberately preset-free launch; forwarding
    // undefined would let the agent-level default reappear on recovery.
    presetId: panel.agentPresetId ?? null,
    // A dock replacement that doesn't activate starts parked and offscreen, so
    // the recovery the user just asked for would produce nothing visible.
    activateDockOnCreate: location === "dock" ? true : undefined,
    env: readPresetEnv(panel),
    // Since env is persisted onto the panel (#10922), dropping this would let a
    // session-scoped secret leak into the on-disk snapshot on relaunch.
    excludeFromPersistence: panel.excludeFromPersistence,
    // Dropping these three rewrote the launch on the way through: an ephemeral
    // pane came back permanent, a background spawn stole focus, and an
    // automated one came back attributed to the user.
    removeOnExit: panel.removeOnExit,
    focusPolicy: panel.focusPolicy,
    spawnedBy: panel.spawnedBy,
  };
}

/** Key-sorted, undefined-pruned serialization so field order never splits two equal launches. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Identity of the launch a gate stands in for. Two gates are the same gate
 * exactly when they would relaunch identically — so a different worktree,
 * location, preset, model, cwd, or flag set stays a separate panel.
 */
export function missingCliRelaunchKey(panel: PtyPanelData): string | null {
  const options = buildMissingCliRelaunchOptions(panel);
  return options ? stableStringify(options) : null;
}

/**
 * Find a live gate already standing in for this launch.
 *
 * The gate bypasses `addPanel`, so nothing else caps how many can exist: without
 * this, clicking an unavailable agent three times would append three identical
 * diagnostic panels.
 *
 * Only gates the user can actually see are reusable. A trashed or backgrounded
 * gate still sits in the registry, and matching one would answer the click by
 * pointing at a panel that renders nowhere — worse than making a second gate.
 */
export function findEquivalentMissingCliGate(
  panelsById: Record<string, PanelInstance>,
  panelIds: string[],
  candidate: PtyPanelData,
  options: { requestedId?: string } = {}
): string | null {
  // A caller-owned id is an identity contract — that launch is owed its own
  // panel, so it must never collapse onto someone else's gate.
  if (options.requestedId) return null;

  const key = missingCliRelaunchKey(candidate);
  if (key === null) return null;

  for (const id of panelIds) {
    if (id === candidate.id) continue;
    const panel = panelsById[id];
    if (!panel || !isPtyPanel(panel)) continue;
    if (panel.spawnStatus !== "missing-cli") continue;
    if (panel.location !== "grid" && panel.location !== "dock") continue;
    if (missingCliRelaunchKey(panel) === key) return id;
  }
  return null;
}
