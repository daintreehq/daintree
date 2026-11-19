import type { AgentPreset } from "../../../shared/config/agentRegistry.js";
import { getMergedPresets, sanitizePreset } from "../../../shared/utils/agentPresets.js";

/**
 * Whether a pane stopped by a usage limit falls back to another preset rather
 * than waiting for the reset (#17909), decided in main so a renderer that
 * isn't there never reads as "nothing left". The same rule the renderer's
 * fallback applies (`src/store/listeners/panel/lifecycle.ts`): the user's own
 * original preset opted in, and its chain has a preset at the hops taken.
 * `unknown` when a source it needs couldn't be read.
 */
export type LimitFallback = "fallback" | "none" | "unknown";

export interface LimitFallbackRun {
  /** The agent the pane launched, whose presets these are. */
  agentId: string;
  presetId: string | undefined;
  originalPresetId: string | undefined;
  /** Hops taken from the original preset, as the launch said. */
  chainIndex: number | undefined;
}

/** The user's own original preset, when it opted in to falling back on usage limits. */
export function limitFallbackOptIn(
  run: LimitFallbackRun,
  customPresets: AgentPreset[] | undefined
): AgentPreset | null {
  if (run.presetId === undefined) return null;
  const originalId = run.originalPresetId ?? run.presetId;
  const own = getMergedPresets(run.agentId, customPresets, [], []).find(
    (preset) => preset.id === originalId
  );
  return own?.fallbackOnRateLimit === true ? own : null;
}

/**
 * `customPresets` and `projectPresets` are null when they couldn't be read;
 * the project's are needed only for a run that opted in, since its chain may
 * name a project preset.
 */
export function decideLimitFallback(
  run: LimitFallbackRun,
  customPresets: AgentPreset[] | undefined | null,
  projectPresets: AgentPreset[] | undefined | null
): LimitFallback {
  // A launch with no preset has no chain to fall back along.
  if (run.presetId === undefined) return "none";
  if (customPresets === null) return "unknown";
  if (limitFallbackOptIn(run, customPresets) === null) return "none";
  if (projectPresets === null) return "unknown";
  const originalId = run.originalPresetId ?? run.presetId;
  // The chain as the renderer resolves it: every source, so a fallback to a
  // project preset is kept rather than filtered out as unknown.
  const merged = getMergedPresets(run.agentId, customPresets, undefined, projectPresets);
  // A fallback named but not read may be a preset file that failed to read
  // rather than one deleted, and dropping it would move every later hop.
  const known = new Set(merged.map((preset) => preset.id));
  const ownOriginal = customPresets?.find((preset) => preset.id === originalId);
  const named = (ownOriginal && sanitizePreset(ownOriginal)?.fallbacks) ?? [];
  if (named.some((id) => !known.has(id))) return "unknown";
  const chain = merged.find((preset) => preset.id === originalId)?.fallbacks ?? [];
  // A launch that doesn't say is the original's first, never a guess at a hop.
  const index = run.chainIndex ?? (run.presetId === originalId ? 0 : undefined);
  if (index === undefined) return "unknown";
  return chain[index] !== undefined ? "fallback" : "none";
}
