import type { AddPanelOptions } from "@shared/types";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

/**
 * Rebuild the launch a missing-CLI gate panel stood in for.
 *
 * Single source of truth for which fields survive the hop. Both recovery exits
 * relaunch through this — "Run anyway" and the post-refresh continuation — and
 * `missingCliRelaunchKey` derives gate identity from the same output, so a
 * field added here is automatically carried AND compared instead of drifting
 * out of one of three hand-maintained lists.
 *
 * Returns null when the panel carries no agent, which makes it unrelaunchable.
 */
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

export function buildMissingCliRelaunchOptions(panel: PtyPanelData): AddPanelOptions | null {
  const agentId = panel.launchAgentId;
  if (!agentId) return null;

  return {
    kind: "terminal",
    launchAgentId: agentId,
    command: panel.command,
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
    // The fallback tint when the preset is later deleted — dropping it changes
    // the relaunched pane's chrome, so the continued launch would not be the
    // launch that was originally asked for.
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
