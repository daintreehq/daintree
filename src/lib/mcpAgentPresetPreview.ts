/**
 * The confirm preview for the three user-preset writes (#16047).
 *
 * A preset changes what every later launch of its agent runs with, and an env
 * value can redirect model traffic or relax permissions, so the approver reads
 * the exact change rather than the dialog's argument summary, which collapses
 * `env` to `<object>`. Env values are masked by the same test Settings uses, so
 * a token an agent was handed isn't put on a screen that may be shared.
 *
 * Pure formatting over a planned mutation: the plan already read the stored
 * preset, and the run writes from a fresh plan of the same arguments.
 */

import { pluralize } from "@/lib/pluralize";
import type { AgentPresetMutation } from "@/services/actions/definitions/agentPresetMutation";
import { isSecretEnvEntry, maskSecretValue } from "@/utils/secretDetection";
import type { AgentPreset } from "@shared/config/agentRegistry";
import { isValidEnvKey } from "@shared/utils/envVars";

/**
 * Two spaces in front of nested rows. Every line also opens with a label rather
 * than caller text, so none can start with the caution marker the dialog
 * renders as its own warning.
 */
const INDENT = "  ";

/** A dialog subject is one heading line. */
const MAX_SUBJECT_CHARS = 80;

/**
 * Caller text as a quoted literal: whitespace, quotes and control characters
 * show, an empty string reads as `""` rather than nothing, and a line break
 * can't start a line of its own. JSON leaves the two Unicode line separators
 * alone, so they're escaped too.
 */
function quote(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

interface PresetField {
  label: string;
  /** The value as shown, or undefined when the preset doesn't set it. */
  read: (preset: AgentPreset, names: Record<string, string>) => string | undefined;
  /** What an unset field means at launch. */
  unset: string;
}

const PRESET_FIELDS: readonly PresetField[] = [
  {
    label: "Arguments",
    read: (p) =>
      Array.isArray(p.args) && p.args.length > 0 ? p.args.map(quote).join(" ") : undefined,
    unset: "none",
  },
  {
    label: "Custom arguments",
    read: (p) => (typeof p.customFlags === "string" ? quote(p.customFlags) : undefined),
    unset: "the agent's own",
  },
  {
    label: "Skip permissions",
    read: (p) => {
      if (p.dangerousMode === "on") return "On";
      if (p.dangerousMode === "off") return "Off";
      if (p.dangerousMode === undefined && typeof p.dangerousEnabled === "boolean") {
        return p.dangerousEnabled ? "On" : "Off";
      }
      return undefined;
    },
    unset: "the agent's setting",
  },
  {
    label: "Alt-screen mode",
    read: (p) => {
      if (p.inlineMode === "on" || p.inlineMode === true) return "Inline";
      if (p.inlineMode === "off" || p.inlineMode === false) return "Alt screen";
      return undefined;
    },
    unset: "the agent's setting",
  },
  {
    label: "Display title",
    read: (p) => (typeof p.displayTitle === "string" ? quote(p.displayTitle) : undefined),
    unset: "the name",
  },
  {
    label: "Colour",
    read: (p) => (typeof p.color === "string" ? quote(p.color) : undefined),
    unset: "the agent's colour",
  },
  {
    label: "Fallback presets",
    read: (p, names) =>
      Array.isArray(p.fallbacks) && p.fallbacks.length > 0
        ? p.fallbacks.map((id) => quote(names[id] ?? id)).join(", ")
        : undefined,
    unset: "none",
  },
  {
    label: "Fall back on usage limits",
    read: (p) => (p.fallbackOnRateLimit === true ? "On" : undefined),
    unset: "Off",
  },
];

function envEntries(preset: AgentPreset): Map<string, string> {
  const env = preset.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return new Map();
  return new Map(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

/** A stored key that isn't a shell name could hold anything, line breaks included. */
function envKey(key: string): string {
  return isValidEnvKey(key) ? key : quote(key);
}

/** One env value as shown: masked when the entry reads as a secret either side of the change. */
function envValue(value: string, secret: boolean): string {
  return secret ? maskSecretValue(value) : quote(value);
}

/** Every value a preset sets, for a create or for what a delete takes away. */
function presetContentLines(preset: AgentPreset, names: Record<string, string>): string[] {
  const lines: string[] = [];
  const env = envEntries(preset);
  if (env.size > 0) {
    lines.push("Environment variables:");
    for (const [key, value] of env) {
      lines.push(`${INDENT}${envKey(key)} = ${envValue(value, isSecretEnvEntry(key, value))}`);
    }
  }
  for (const field of PRESET_FIELDS) {
    const value = field.read(preset, names);
    if (value !== undefined) lines.push(`${field.label}: ${value}`);
  }
  return lines;
}

/** Each field and env entry an update changes, as `old → new`. */
function presetChangeLines(
  before: AgentPreset,
  after: AgentPreset,
  names: Record<string, string>
): string[] {
  const lines: string[] = [];
  if (before.name !== after.name) lines.push(`Name: ${quote(before.name)} → ${quote(after.name)}`);
  const oldEnv = envEntries(before);
  const newEnv = envEntries(after);
  const envLines: string[] = [];
  for (const key of new Set([...oldEnv.keys(), ...newEnv.keys()])) {
    const was = oldEnv.get(key);
    const now = newEnv.get(key);
    if (was === now) continue;
    const secret = isSecretEnvEntry(key, ...[was, now].filter((v): v is string => v !== undefined));
    const from = was === undefined ? "not set" : envValue(was, secret);
    const to = now === undefined ? "removed" : envValue(now, secret);
    envLines.push(`${INDENT}${envKey(key)}: ${from} → ${to}`);
  }
  if (envLines.length > 0) lines.push("Environment variables:", ...envLines);
  for (const field of PRESET_FIELDS) {
    const was = field.read(before, names);
    const now = field.read(after, names);
    if (was === now) continue;
    lines.push(`${field.label}: ${was ?? field.unset} → ${now ?? field.unset}`);
  }
  return lines;
}

export function formatAgentPresetPreviewLines(mutation: AgentPresetMutation): string[] {
  const { agentName, presetNames } = mutation;
  const agentLine = `Agent: ${agentName}`;
  if (mutation.operation === "create") {
    return [
      agentLine,
      `Name: ${quote(mutation.preset.name)}`,
      ...presetContentLines(mutation.preset, presetNames),
      `${agentName}'s default preset stays as it is.`,
    ];
  }
  if (mutation.operation === "update") {
    return [
      agentLine,
      `Preset: ${quote(mutation.before.name)}`,
      ...presetChangeLines(mutation.before, mutation.preset, presetNames),
    ];
  }
  const lines = [
    agentLine,
    `Preset: ${quote(mutation.preset.name)}`,
    ...presetContentLines(mutation.preset, presetNames),
  ];
  if (mutation.wasAgentDefault) {
    lines.push(`It's ${agentName}'s default preset, so the default is cleared.`);
  }
  if (mutation.worktreeDefaults > 0) {
    lines.push(
      `Still picked in ${pluralize(mutation.worktreeDefaults, "worktree")}; launches there go back to ${agentName}'s default.`
    );
  }
  return lines;
}

/** The preset a write names, for the dialog title: one line, bounded. */
export function agentPresetPreviewSubject(mutation: AgentPresetMutation): string | undefined {
  const name = mutation.operation === "update" ? mutation.before.name : mutation.preset.name;
  if (typeof name !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim();
  if (flat.length === 0) return undefined;
  const points = Array.from(flat);
  return points.length > MAX_SUBJECT_CHARS
    ? `${points.slice(0, MAX_SUBJECT_CHARS - 1).join("")}…`
    : flat;
}
