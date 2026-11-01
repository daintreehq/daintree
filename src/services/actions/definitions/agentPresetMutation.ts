import { z } from "zod";
import {
  getEffectiveAgentConfig,
  isEffectivelyRegisteredAgent,
  type AgentPreset,
} from "@shared/config/agentRegistry";
import type { AgentSettings, AgentSettingsEntry } from "@shared/types/agentSettings";
import {
  getMergedPresetIdentities,
  getMergedPresets,
  sanitizeAgentEnv,
  sanitizePreset,
  type AgentPresetSource,
} from "@shared/utils/agentPresets";
import { isValidEnvKey } from "@shared/utils/envVars";
import {
  AgentCreatePresetArgsSchema,
  AgentDeletePresetArgsSchema,
  AgentUpdatePresetArgsSchema,
} from "./agentActionArgs";

/**
 * The three user-preset writes on the action surface (#16047), planned once for
 * the confirm preview and again by the run against the store it writes.
 *
 * A model-written preset can't go through the sanitiser the way Settings'
 * presets do. `sanitizePreset` only runs when presets are read, so anything it
 * would drop or rewrite (an arg with a shell metacharacter, `PATH` in env) would
 * be stored as approved and then quietly vanish at launch. The plan refuses
 * those instead, naming each field, so the caller can fix the call before the
 * user is asked and the preview shows exactly what launches will use.
 */
export const AGENT_PRESET_MUTATION_ACTION_IDS = [
  "agent.createPreset",
  "agent.updatePreset",
  "agent.deletePreset",
] as const;

export type AgentPresetMutationActionId = (typeof AGENT_PRESET_MUTATION_ACTION_IDS)[number];

export function isAgentPresetMutationAction(id: string): id is AgentPresetMutationActionId {
  return (AGENT_PRESET_MUTATION_ACTION_IDS as readonly string[]).includes(id);
}

/** The layers a plan reads, the same three the launcher merges. */
export interface AgentPresetSources {
  /** The stored agent settings, or null while they haven't loaded. */
  settings: AgentSettings | null;
  ccrPresetsByAgent: Record<string, AgentPreset[]>;
  /** Undefined unless the loaded repository presets belong to the caller's project. */
  projectPresetsByAgent: Record<string, AgentPreset[]> | undefined;
}

/** One agent's presets from one layer. */
interface AgentPresetLayers {
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
}

interface MutationBase {
  agentId: string;
  /** The agent's display name, for the preview and refusals. */
  agentName: string;
  /** The agent's whole user-preset list once this write lands. */
  customPresets: AgentPreset[];
  /** Names of the presets a fallback chain here names, by id, for the preview. */
  presetNames: Record<string, string>;
}

export type AgentPresetMutation =
  | (MutationBase & { operation: "create"; preset: AgentPreset })
  | (MutationBase & { operation: "update"; before: AgentPreset; preset: AgentPreset })
  | (MutationBase & {
      operation: "delete";
      preset: AgentPreset;
      /** The agent-level default named this preset, so the write clears it. */
      wasAgentDefault: boolean;
      /** Worktrees whose own default still names it until their next launch. */
      worktreeDefaults: number;
    });

export type AgentPresetMutationPlan =
  { ok: true; mutation: AgentPresetMutation } | { ok: false; message: string };

type PresetMode = "inherit" | "on" | "off";

interface PresetPatch {
  name?: string;
  envSet?: Record<string, string>;
  envUnset?: string[];
  args?: string[];
  customFlags?: string | null;
  dangerousMode?: PresetMode;
  inlineMode?: PresetMode;
  color?: string;
  displayTitle?: string;
  fallbacks?: string[];
  fallbackOnRateLimit?: boolean;
}

const PATCH_FIELDS = [
  "name",
  "envSet",
  "envUnset",
  "args",
  "customFlags",
  "dangerousMode",
  "inlineMode",
  "color",
  "displayTitle",
  "fallbacks",
  "fallbackOnRateLimit",
] as const satisfies readonly (keyof PresetPatch)[];

const SHELL_METACHARS = '; | & > < $( ${ ` \\';

const SOURCE_LABELS: Record<Exclude<AgentPresetSource, "custom">, string> = {
  project: "repository",
  ccr: "CCR",
  registry: "built-in",
};

/**
 * The settings write a planned mutation makes, through the same `updateAgent`
 * Settings uses. Never sets `presetId`: Settings makes a preset it creates the
 * default, and a write the user approved as "create this preset" must not also
 * change what every later launch picks. A delete clears the default only when
 * it named the deleted preset, as Settings' delete does.
 */
export function agentPresetMutationUpdates(
  mutation: AgentPresetMutation
): Partial<AgentSettingsEntry> {
  if (mutation.operation === "delete" && mutation.wasAgentDefault) {
    return { customPresets: mutation.customPresets, presetId: undefined };
  }
  return { customPresets: mutation.customPresets };
}

/**
 * Plan one preset write against `sources`, or say why it can't be made.
 * `newPresetId` is used only by a create, and only the run's id is ever stored.
 */
export function planAgentPresetMutation(
  actionId: AgentPresetMutationActionId,
  args: unknown,
  sources: AgentPresetSources,
  newPresetId: string
): AgentPresetMutationPlan {
  const parsed = parseArgs(actionId, args);
  if (!parsed.ok) return parsed;
  const { agentId } = parsed.data;
  if (!isEffectivelyRegisteredAgent(agentId)) {
    return refuse(`There's no agent "${agentId}"; the agent listing names them.`);
  }
  if (!sources.settings) {
    return refuse("Agent settings haven't loaded yet, so the preset can't be checked. Try again.");
  }
  const agentName = getEffectiveAgentConfig(agentId)?.name ?? agentId;
  // Absent keeps the built-in registry presets and an own array replaces them,
  // as the launcher reads these layers.
  const layers: AgentPresetLayers = {
    ccrPresets: ownBucket(sources.ccrPresetsByAgent, agentId),
    projectPresets: sources.projectPresetsByAgent
      ? ownBucket(sources.projectPresetsByAgent, agentId)
      : undefined,
  };
  const agents = sources.settings.agents;
  const entry = agents && Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
  const stored: unknown = entry?.customPresets;
  const custom: AgentPreset[] = Array.isArray(stored) ? (stored as AgentPreset[]) : [];

  if (parsed.action === "agent.createPreset") {
    const { agentId: _agent, name, env, ...fields } = parsed.data;
    const patch: PresetPatch = { ...fields, name, ...(env !== undefined ? { envSet: env } : {}) };
    const preset = applyPresetPatch({ id: newPresetId, name }, patch);
    const customPresets = [...custom, preset];
    const problems = presetProblems(preset, patch, knownPresetIds(agentId, customPresets, layers));
    if (problems.length > 0) return refusePresetProblems(problems);
    const presetNames = fallbackPresetNames(agentId, [customPresets], layers, [preset]);
    return {
      ok: true,
      mutation: { operation: "create", agentId, agentName, customPresets, presetNames, preset },
    };
  }

  const { presetId } = parsed.data;
  const target = custom.find((preset) => isRecord(preset) && preset.id === presetId);
  if (!target) return refuse(missingPresetMessage(agentId, agentName, presetId, custom, layers));

  if (parsed.action === "agent.deletePreset") {
    const worktreePresets = entry && isRecord(entry.worktreePresets) ? entry.worktreePresets : {};
    return {
      ok: true,
      mutation: {
        operation: "delete",
        agentId,
        agentName,
        customPresets: custom.filter((preset) => !isRecord(preset) || preset.id !== presetId),
        presetNames: fallbackPresetNames(agentId, [custom], layers, [target]),
        preset: target,
        wasAgentDefault: entry?.presetId === presetId,
        worktreeDefaults: Object.values(worktreePresets).filter((id) => id === presetId).length,
      },
    };
  }

  const { agentId: _agent, presetId: _preset, ...patch } = parsed.data;
  if (!PATCH_FIELDS.some((field) => patch[field] !== undefined)) {
    return refuse("Nothing to change: name a field, envSet or envUnset.");
  }
  const unsetKeys = new Set(patch.envUnset ?? []);
  const doubled = Object.keys(patch.envSet ?? {}).filter((key) => unsetKeys.has(key));
  if (doubled.length > 0) {
    return refuse(`${doubled.map((key) => `"${key}"`).join(", ")} is in both envSet and envUnset.`);
  }
  const preset = applyPresetPatch(target, patch);
  if (canonical(preset) === canonical(target)) {
    return refuse(`Nothing to change: "${target.name}" already has these values.`);
  }
  // Every preset sharing the id changes, as Settings' edit maps them.
  const customPresets = custom.map((existing) =>
    isRecord(existing) && existing.id === presetId ? applyPresetPatch(existing, patch) : existing
  );
  const problems = presetProblems(preset, patch, knownPresetIds(agentId, customPresets, layers));
  if (problems.length > 0) return refusePresetProblems(problems);
  const presetNames = fallbackPresetNames(agentId, [custom, customPresets], layers, [
    target,
    preset,
  ]);
  return {
    ok: true,
    mutation: {
      operation: "update",
      agentId,
      agentName,
      customPresets,
      presetNames,
      before: target,
      preset,
    },
  };
}

type ParsedArgs =
  | { ok: true; action: "agent.createPreset"; data: z.infer<typeof AgentCreatePresetArgsSchema> }
  | { ok: true; action: "agent.updatePreset"; data: z.infer<typeof AgentUpdatePresetArgsSchema> }
  | { ok: true; action: "agent.deletePreset"; data: z.infer<typeof AgentDeletePresetArgsSchema> };

function parseArgs(
  actionId: AgentPresetMutationActionId,
  args: unknown
): ParsedArgs | { ok: false; message: string } {
  const invalid = (error: z.ZodError) => refuse(`Invalid arguments: ${z.prettifyError(error)}`);
  if (actionId === "agent.createPreset") {
    const result = AgentCreatePresetArgsSchema.safeParse(args);
    return result.success ? { ok: true, action: actionId, data: result.data } : invalid(result.error);
  }
  if (actionId === "agent.updatePreset") {
    const result = AgentUpdatePresetArgsSchema.safeParse(args);
    return result.success ? { ok: true, action: actionId, data: result.data } : invalid(result.error);
  }
  const result = AgentDeletePresetArgsSchema.safeParse(args);
  return result.success ? { ok: true, action: actionId, data: result.data } : invalid(result.error);
}

function refuse(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function refusePresetProblems(problems: string[]): { ok: false; message: string } {
  return refuse(
    `Refused before asking the user. Fix these and call again:\n${problems.map((p) => `- ${p}`).join("\n")}`
  );
}

/**
 * `agentId` is caller-supplied, so an inherited key like `__proto__` must not
 * resolve to `Object.prototype`, and a corrupted bucket reads as absent.
 */
function ownBucket(
  byAgent: Record<string, AgentPreset[]>,
  agentId: string
): AgentPreset[] | undefined {
  if (!Object.hasOwn(byAgent, agentId)) return undefined;
  const bucket = byAgent[agentId];
  return Array.isArray(bucket) ? bucket : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingPresetMessage(
  agentId: string,
  agentName: string,
  presetId: string,
  custom: AgentPreset[],
  layers: AgentPresetLayers
): string {
  const identity = getMergedPresetIdentities(
    agentId,
    custom,
    layers.ccrPresets,
    layers.projectPresets
  ).find((preset) => preset.id === presetId);
  if (identity && identity.source !== "custom") {
    return `"${identity.name}" is a ${SOURCE_LABELS[identity.source]} preset, which can't be changed here; only the user's own presets can.`;
  }
  return `${agentName} has no user preset "${presetId}"; the preset listing names them.`;
}

/**
 * The patch applied to a copy of `base`. Omitted fields are kept; an empty
 * list or string, "inherit", false, or `customFlags: null` clears a field, so
 * the result stores nothing the sanitiser would turn into "absent" on read.
 */
function applyPresetPatch(base: AgentPreset, patch: PresetPatch): AgentPreset {
  const next: AgentPreset = { ...base };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.envSet !== undefined || patch.envUnset !== undefined) {
    // A Map and `fromEntries`, never assignment, so a key like `__proto__`
    // stays an own key the sanitiser check can refuse.
    const env = new Map(Object.entries(isRecord(base.env) ? base.env : {}));
    for (const key of patch.envUnset ?? []) env.delete(key);
    for (const [key, value] of Object.entries(patch.envSet ?? {})) env.set(key, value);
    if (env.size > 0) next.env = Object.fromEntries(env) as Record<string, string>;
    else delete next.env;
  }
  if (patch.args !== undefined) {
    if (patch.args.length > 0) next.args = [...patch.args];
    else delete next.args;
  }
  if (patch.customFlags !== undefined) {
    if (patch.customFlags === null) delete next.customFlags;
    else next.customFlags = patch.customFlags;
  }
  if (patch.dangerousMode !== undefined) {
    // The legacy boolean mirrors the mode, as Settings' editor writes it.
    if (patch.dangerousMode === "inherit") {
      delete next.dangerousMode;
      delete next.dangerousEnabled;
    } else {
      next.dangerousMode = patch.dangerousMode;
      next.dangerousEnabled = patch.dangerousMode === "on";
    }
  }
  if (patch.inlineMode !== undefined) {
    if (patch.inlineMode === "inherit") delete next.inlineMode;
    else next.inlineMode = patch.inlineMode;
  }
  if (patch.color !== undefined) {
    if (patch.color === "") delete next.color;
    else next.color = patch.color;
  }
  if (patch.displayTitle !== undefined) {
    if (patch.displayTitle === "") delete next.displayTitle;
    else next.displayTitle = patch.displayTitle;
  }
  if (patch.fallbacks !== undefined) {
    if (patch.fallbacks.length > 0) next.fallbacks = [...patch.fallbacks];
    else delete next.fallbacks;
  }
  if (patch.fallbackOnRateLimit !== undefined) {
    if (patch.fallbackOnRateLimit) next.fallbackOnRateLimit = true;
    else delete next.fallbackOnRateLimit;
  }
  return next;
}

/** Ids a fallback may name once this write lands, as the launcher merges them. */
function knownPresetIds(
  agentId: string,
  customPresets: AgentPreset[],
  layers: AgentPresetLayers
): Set<string> {
  return new Set(
    getMergedPresets(agentId, customPresets, layers.ccrPresets, layers.projectPresets).map(
      (preset) => preset.id
    )
  );
}

/** The names of the presets `presets`' fallback chains name, from any of `lists`. */
function fallbackPresetNames(
  agentId: string,
  lists: AgentPreset[][],
  layers: AgentPresetLayers,
  presets: AgentPreset[]
): Record<string, string> {
  const wanted = new Set(
    presets.flatMap((preset) => (Array.isArray(preset.fallbacks) ? preset.fallbacks : []))
  );
  const names = new Map<string, string>();
  if (wanted.size === 0) return {};
  for (const list of lists) {
    for (const identity of getMergedPresetIdentities(
      agentId,
      list,
      layers.ccrPresets,
      layers.projectPresets
    )) {
      if (wanted.has(identity.id) && !names.has(identity.id)) names.set(identity.id, identity.name);
    }
  }
  return Object.fromEntries(names);
}

/**
 * Each value this write sets that the read-time sanitiser would drop or change.
 *
 * Only what the write touches is checked: a stored preset carrying a value the
 * sanitiser already drops keeps behaving as it does today, and an unrelated
 * edit to it isn't refused for something the caller never sent. Each value is
 * probed through the sanitiser itself, so these rules can't drift from it; the
 * messages say what is allowed, never the refused value, which may be a secret.
 */
function presetProblems(
  preset: AgentPreset,
  patch: PresetPatch,
  knownIds: ReadonlySet<string>
): string[] {
  // Only a stored preset can carry an id launches refuse; a create's is minted.
  if (sanitizePreset({ id: preset.id, name: "id" }) === null) {
    return ["This preset's stored id can't be used at launch, so it can't be edited; remove it instead."];
  }
  const problems: string[] = [];
  const probe = (fields: Partial<AgentPreset>) =>
    sanitizePreset({ id: preset.id, name: "probe", ...fields });

  // A stored name launches already drop counts too: an edit that leaves it
  // would be approved and then never offered.
  const name = patch.name ?? preset.name;
  if (sanitizePreset({ id: preset.id, name })?.name !== name) {
    problems.push(
      patch.name !== undefined
        ? "name: 1–200 characters, no < or >, and no leading or trailing spaces."
        : "name: the stored name can't be used at launch, so set a new one in the same call."
    );
  }
  for (const [key, value] of Object.entries(patch.envSet ?? {})) {
    if (!isValidEnvKey(key)) {
      problems.push(
        `env "${key}": a name starts with a letter or underscore, then uses only letters, digits and underscores.`
      );
      continue;
    }
    const kept = sanitizeAgentEnv(Object.fromEntries([[key, value]]));
    if (!kept || !Object.hasOwn(kept, key) || kept[key] !== value) {
      problems.push(
        `env "${key}": PATH and library-loader variables can't be set, and a value can't contain "$(", a backtick, ";" or "|", or run past 10,000 characters.`
      );
    }
  }
  if (patch.args !== undefined) {
    patch.args.forEach((arg, index) => {
      if (probe({ args: [arg] })?.args?.[0] !== arg) {
        problems.push(
          `args[${index}]: an argument can't be empty, run past 10,000 characters, or contain control characters or shell metacharacters (${SHELL_METACHARS}).`
        );
      }
    });
  }
  if (typeof patch.customFlags === "string" && patch.customFlags !== "") {
    if (probe({ customFlags: patch.customFlags })?.customFlags !== patch.customFlags) {
      problems.push(
        `customFlags: no shell metacharacters (${SHELL_METACHARS}) and at most 10,000 characters.`
      );
    }
  }
  if (patch.color && probe({ color: patch.color })?.color !== patch.color) {
    problems.push("color: a hex colour of 3, 4, 6 or 8 digits, such as #3b82f6.");
  }
  if (
    patch.displayTitle &&
    probe({ displayTitle: patch.displayTitle })?.displayTitle !== patch.displayTitle
  ) {
    problems.push(
      'displayTitle: up to 100 characters, no < or >, no control characters, and no leading or trailing spaces; "" clears it.'
    );
  }
  if (patch.fallbacks !== undefined && patch.fallbacks.length > 0) {
    const kept = probe({ fallbacks: patch.fallbacks })?.fallbacks ?? [];
    if (canonical(kept) !== canonical(patch.fallbacks)) {
      problems.push("fallbacks: up to 3 distinct preset ids, not this preset's own.");
    } else {
      for (const id of patch.fallbacks) {
        if (!knownIds.has(id)) {
          problems.push(`fallbacks: "${id}" isn't one of this agent's presets.`);
        }
      }
    }
  }
  return problems;
}

/** Key-order-free JSON, for telling a real change from a no-op. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}
