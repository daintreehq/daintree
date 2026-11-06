import { type AgentPreset, getEffectiveAgentConfig } from "../config/agentRegistry.js";
import {
  getMergedPreset,
  getMergedPresetIdentities,
  getMergedPresets,
  type AgentPresetSource,
} from "./agentPresets.js";
import {
  AGENT_LAUNCH_ACTION_ID,
  dispatchCarriesAgentLaunchEnv,
  dispatchCarriesAgentLaunchFlags,
  dispatchCarriesAgentSystemPrompt,
  dispatchCarriesOptionLikeValue,
} from "./dispatchAgentLaunch.js";

/**
 * Launching an agent on one of the person's presets from a plugin (#16324).
 *
 * A preset is configuration the person wrote, not configuration a plugin
 * chose, so a plugin may name one — but only one the person approved for that
 * plugin, in its exact current content. Picking among presets is still a
 * choice (one of them may turn bypass on), which is why the consent is per
 * preset and ends when the preset changes.
 */
export const AGENT_LAUNCH_PRESET_CAPABILITY = "agent:launch-preset" as const;

/** Which preset a grant is for. The source is part of it: the dialog named it. */
export interface PluginPresetLaunchTarget {
  agentId: string;
  presetId: string;
  source: AgentPresetSource;
}

/**
 * The host's attestation that a plugin's `agent.launch` may use this preset,
 * minted in main after the consent check and carried beside the dispatch,
 * never in its arguments. `content` is {@link presetLaunchContent} of the
 * preset as approved: the launch compares the preset it actually resolves
 * against it, so a preset that changed after the check never launches under
 * the approval. It holds env values, so it stays on this machine — the
 * dispatch envelope is local IPC and nothing logs it.
 */
export interface HostApprovedPluginPresetLaunch {
  agentId: string;
  presetId: string;
  source: AgentPresetSource;
  content: string;
  /**
   * `[id, content]` of each preset the approved one falls back to, in chain
   * order. A hop runs on one of these without asking again, so the person
   * approved them with it and each hop is held to its content too.
   */
  fallbacks: Array<[string, string]>;
}

/**
 * Display-safe account of what launching on a preset turns on, for the
 * consent dialog. Env values never leave main: only the names do.
 */
export interface PluginPresetLaunchSummary {
  agentId: string;
  agentName: string;
  presetId: string;
  presetName: string;
  source: AgentPresetSource;
  args: string[];
  /** Present when the preset replaces the agent's own extra flags. */
  customFlags?: string;
  /** The preset's own bypass override, before the agent's setting is layered under it. */
  dangerousMode: "inherit" | "on" | "off";
  /** Whether a launch on this preset skips permission prompts, with today's agent settings. */
  skipsPermissions: boolean;
  /** The account the preset pins, when it pins one. A worktree's own account still wins. */
  accountName?: string;
  envNames: string[];
  /** Presets this one hands over to when its provider fails, in order. */
  fallbackNames: string[];
  fallbackOnRateLimit: boolean;
}

/**
 * The canonical content of a merged, sanitized preset: every field a preset
 * stores, in a fixed order, with env keys sorted. A version tag leads so a
 * future field can change the encoding without colliding with an old one.
 *
 * Every field counts, cosmetic ones included, because the rule is that an edit
 * ends the grant; a field only display reads still changes what the person was
 * shown. Fields the type doesn't know are left out — `sanitizePreset` spreads
 * whatever a JSON file held, and nothing reads an unknown key.
 */
export function presetLaunchContent(preset: AgentPreset): string {
  const env =
    preset.env === undefined
      ? null
      : Object.keys(preset.env)
          .sort()
          .map((key) => [key, preset.env![key]]);
  return JSON.stringify([
    1,
    preset.id,
    preset.name,
    preset.description ?? null,
    preset.args ?? null,
    env,
    preset.dangerousEnabled ?? null,
    preset.dangerousMode ?? null,
    preset.customFlags ?? null,
    preset.inlineMode ?? null,
    preset.color ?? null,
    preset.displayTitle ?? null,
    preset.fallbacks ?? null,
    preset.fallbackOnRateLimit ?? null,
    preset.keepConversationOnRateLimit ?? null,
    preset.accountId ?? null,
  ]);
}

/**
 * The `{ agentId, presetId }` of a plugin `agent.launch` that configures the
 * agent only by naming a preset, or null for anything else. `presetId: null`
 * is not one: it names nothing to approve and drops the default preset, which
 * may be the one vetoing a bypass. Any other launch configuration — flags,
 * env, a system prompt, an option-like prompt or model — keeps the dispatch
 * ineligible, so it is refused exactly as before.
 */
export function pluginPresetLaunchRequest(
  actionId: string,
  args: unknown
): { agentId: string; presetId: string } | null {
  if (actionId !== AGENT_LAUNCH_ACTION_ID) return null;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const { agentId, presetId } = record;
  if (typeof agentId !== "string" || agentId === "") return null;
  if (typeof presetId !== "string" || presetId === "") return null;
  if (
    dispatchCarriesAgentLaunchFlags(args) ||
    dispatchCarriesAgentLaunchEnv(args) ||
    dispatchCarriesAgentSystemPrompt(args) ||
    dispatchCarriesOptionLikeValue(args)
  ) {
    return null;
  }
  return { agentId, presetId };
}

/**
 * Whether a host approval answers for this dispatch: the same agent and the
 * same preset, with nothing else configuring the launch. Read by
 * `ActionService` before it lets a plugin's configured launch through.
 */
export function hostApprovalCoversPresetLaunch(
  approval: HostApprovedPluginPresetLaunch | undefined,
  actionId: string,
  args: unknown
): boolean {
  if (approval === undefined) return false;
  const request = pluginPresetLaunchRequest(actionId, args);
  return (
    request !== null &&
    request.agentId === approval.agentId &&
    request.presetId === approval.presetId
  );
}

/** What an approval is made of, resolved from the same layers a launch merges. */
export interface PresetLaunchParts {
  preset: AgentPreset;
  source: AgentPresetSource;
  content: string;
  fallbacks: Array<[string, string]>;
  /** Every merged preset, for naming the fallbacks. */
  merged: AgentPreset[];
}

/**
 * Resolve a preset and its fallback chain the way a launch does: the same
 * merge, the same precedence, the same CCR-or-registry bucket. Shared by main,
 * which asks about it, and the launcher, which is held to it, so the two
 * can only disagree when the presets themselves changed.
 */
export function resolvePresetLaunchParts(
  agentId: string,
  presetId: string,
  customPresets: AgentPreset[] | undefined,
  ccrPresets: AgentPreset[] | undefined,
  projectPresets: AgentPreset[] | undefined
): PresetLaunchParts | undefined {
  const preset = getMergedPreset(agentId, presetId, customPresets, ccrPresets, projectPresets);
  if (!preset) return undefined;
  const source =
    getMergedPresetIdentities(agentId, customPresets, ccrPresets, projectPresets).find(
      (identity) => identity.id === preset.id
    )?.source ?? "custom";
  const merged = getMergedPresets(
    agentId,
    customPresets,
    ccrPresets ?? getEffectiveAgentConfig(agentId)?.presets ?? [],
    projectPresets
  );
  const fallbacks: Array<[string, string]> = [];
  for (const id of preset.fallbacks ?? []) {
    const fallback = merged.find((candidate) => candidate.id === id);
    if (fallback) fallbacks.push([id, presetLaunchContent(fallback)]);
  }
  return { preset, source, content: presetLaunchContent(preset), fallbacks, merged };
}

/** Whether a launch's resolved preset is exactly the one approved, chain included. */
export function presetLaunchMatchesApproval(
  approval: HostApprovedPluginPresetLaunch,
  parts: PresetLaunchParts | undefined
): boolean {
  return (
    parts !== undefined &&
    parts.preset.id === approval.presetId &&
    parts.source === approval.source &&
    parts.content === approval.content &&
    JSON.stringify(parts.fallbacks) === JSON.stringify(approval.fallbacks)
  );
}
