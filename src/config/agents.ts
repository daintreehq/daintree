import type { ComponentType, CSSProperties } from "react";
import {
  AGENT_REGISTRY as BASE_AGENT_REGISTRY,
  type AgentConfig as BaseAgentConfig,
  type AgentPreset,
  type AgentProviderTemplate,
  FALLBACK_CHAIN_MAX,
  getEffectiveAgentConfig,
  getEffectiveAgentIds,
  isEffectivelyRegisteredAgent,
  getAgentDisplayTitle,
  getAssistantSupportedAgentIds,
} from "../../shared/config/agentRegistry";
import { hasShellMetachar } from "../../shared/utils/shellEscape";

export { getAgentDisplayTitle, getAssistantSupportedAgentIds };
export type { AgentPreset, AgentProviderTemplate };
import { resolveAgentIcon } from "./agentIcons";

export interface AgentIconProps {
  className?: string;
  size?: number;
  /** Set by `BrandMark`, which publishes the resolved rest/hover inks here. */
  style?: CSSProperties;
}

export interface AgentConfig extends BaseAgentConfig {
  icon: ComponentType<AgentIconProps>;
}

export const AGENT_REGISTRY: Record<string, AgentConfig> = Object.fromEntries(
  Object.entries(BASE_AGENT_REGISTRY).map(([id, config]) => {
    return [id, { ...config, icon: resolveAgentIcon(config.iconId) }];
  })
) as Record<string, AgentConfig>;

export const AGENT_IDS = Object.keys(AGENT_REGISTRY) as string[];

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  const config = getEffectiveAgentConfig(agentId);
  if (!config) return undefined;
  return { ...config, icon: resolveAgentIcon(config.iconId) };
}

export function isRegisteredAgent(agentId: string): boolean {
  return isEffectivelyRegisteredAgent(agentId);
}

export function getAgentIds(): string[] {
  return getEffectiveAgentIds();
}

export const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Anthropic's CLI",
  gemini: "Google's CLI",
  antigravity: "Google's CLI",
  codex: "OpenAI's CLI",
  grok: "xAI's CLI",
  opencode: "Open-source CLI",
  cursor: "Cursor's CLI",
  kiro: "Amazon's CLI",
  copilot: "GitHub's CLI",
  crush: "Charm's CLI",
  interpreter: "Open Interpreter's CLI",
  mistral: "Mistral's CLI",
  kimi: "Moonshot AI's CLI",
  "daintree-assistant": "Daintree's built-in assistant",
};

/**
 * Sanitizes an env var map: rejects dangerous keys, injection patterns,
 * non-string values, and prototype-polluting keys.
 * Returns undefined when no safe entries remain.
 */
export function sanitizeAgentEnv(
  env: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!env || typeof env !== "object") return undefined;
  const sanitized: Record<string, string> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(env);
  } catch {
    return undefined;
  }
  for (const [key, rawValue] of entries) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value.includes("$(") || value.includes("`") || value.includes(";") || value.includes("|"))
      continue;
    if (value.length > 10000) continue;
    if (["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"].includes(key.toUpperCase()))
      continue;
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Sanitizes a preset's free-form display title: coerces non-strings to
 * undefined, strips control characters, blocks XSS-relevant angle brackets,
 * caps length, and treats empty/whitespace-only values as "no custom title".
 */
export function sanitizeDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Drop C0 (0x00–0x1f), DEL (0x7f), and C1 (0x80–0x9f) control chars without
  // a control-char regex literal.
  const cleaned = Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join("")
    .trim();
  if (!cleaned) return undefined;
  if (/[<>]/.test(cleaned)) return undefined;
  return cleaned.slice(0, 100);
}

/**
 * Validate and sanitize one preset, returning null when it is unusable.
 *
 * Module-level rather than nested so the identity projection below shares the
 * exact same rules; a second copy would drift the moment either is edited.
 */
function sanitizePreset(preset: AgentPreset): AgentPreset | null {
  // Trim name first so a whitespace-only string is caught by the empty check below
  const trimmedName = preset.name?.trim() ?? "";
  if (!preset.id || !trimmedName) return null;
  if (trimmedName.length > 200) return null;
  if (/[<>]/.test(trimmedName)) return null; // Block XSS-relevant angle brackets only
  if (preset.id.length > 100) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(preset.id)) return null; // Only safe ID chars

  // Sanitize args array — filter out non-string, empty, injection-containing, or oversized entries
  const sanitizeArgs = (args?: string[]): string[] | undefined => {
    if (!Array.isArray(args)) return undefined;
    const safe = args.filter(
      (a) => typeof a === "string" && a.length > 0 && a.length <= 10000 && !hasShellMetachar(a)
    );
    return safe.length > 0 ? safe : undefined;
  };

  const sanitizeFallbacks = (fallbacks?: string[], selfId?: string): string[] | undefined => {
    if (!Array.isArray(fallbacks)) return undefined;
    const seen = new Set<string>();
    const safe: string[] = [];
    for (const entry of fallbacks) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || trimmed.length > 100) continue;
      if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) continue;
      if (trimmed === selfId) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      safe.push(trimmed);
      if (safe.length >= FALLBACK_CHAIN_MAX) break;
    }
    return safe.length > 0 ? safe : undefined;
  };

  return {
    ...preset,
    name: trimmedName,
    env: sanitizeAgentEnv(preset.env),
    args: sanitizeArgs(preset.args),
    dangerousEnabled:
      typeof preset.dangerousEnabled === "boolean" ? preset.dangerousEnabled : undefined,
    dangerousMode:
      preset.dangerousMode === "inherit" ||
      preset.dangerousMode === "on" ||
      preset.dangerousMode === "off"
        ? preset.dangerousMode
        : undefined,
    customFlags:
      typeof preset.customFlags === "string" && !hasShellMetachar(preset.customFlags)
        ? preset.customFlags.slice(0, 10000)
        : undefined,
    inlineMode:
      preset.inlineMode === "inherit" ||
      preset.inlineMode === "on" ||
      preset.inlineMode === "off" ||
      typeof preset.inlineMode === "boolean"
        ? preset.inlineMode
        : undefined,
    color:
      typeof preset.color === "string" &&
      /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(preset.color)
        ? preset.color
        : undefined,
    displayTitle: sanitizeDisplayTitle(preset.displayTitle),
    fallbacks: sanitizeFallbacks(preset.fallbacks, preset.id),
  };
}

/**
 * Treat anything that is not an array as an absent bucket.
 *
 * Shared by both merges on purpose. A corrupted persisted bucket used to throw
 * on the first `.map()` in the launch-facing merge while the identity merge
 * quietly skipped it, so a listing could certify presets that the very next
 * launch crashed resolving. Absent is the one reading both can agree on.
 */
function presetBucket(value: AgentPreset[] | undefined): AgentPreset[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function getMergedPresets(
  agentId: string,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[]
): AgentPreset[] {
  const ccr = presetBucket(ccrPresets);
  const registryPresets = ccr ?? presetBucket(getAgentConfig(agentId)?.presets) ?? [];
  const custom = presetBucket(customPresets) ?? [];
  const project = presetBucket(projectPresets) ?? [];

  const sanitizedRegistry = registryPresets.map(sanitizePreset).filter(Boolean) as AgentPreset[];
  const sanitizedCustom = custom.map(sanitizePreset).filter(Boolean) as AgentPreset[];
  const sanitizedProject = project.map(sanitizePreset).filter(Boolean) as AgentPreset[];

  // Precedence (first-seen-wins): custom > project > CCR/registry. Custom
  // overrides team-shared project presets, which override CCR-discovered or
  // built-in registry defaults on ID collision.
  const seenIds = new Set<string>();
  const result: AgentPreset[] = [];

  for (const preset of [...sanitizedCustom, ...sanitizedProject, ...sanitizedRegistry]) {
    if (!seenIds.has(preset.id)) {
      seenIds.add(preset.id);
      result.push(preset);
    }
  }

  // Second pass: filter fallbacks[] against known preset IDs so unknown
  // references don't propagate to the launcher.
  const knownIds = new Set(result.map((p) => p.id));
  for (const preset of result) {
    if (preset.fallbacks?.length) {
      const filtered = preset.fallbacks.filter((id) => knownIds.has(id));
      preset.fallbacks = filtered.length > 0 ? filtered : undefined;
    }
  }

  return result;
}

/**
 * Which layer a merged preset came from. `registry` is the built-in bucket
 * declared by the agent config; `ccr` replaces that bucket wholesale when the
 * caller supplies CCR-discovered presets, which is why the label is decided per
 * bucket rather than per preset.
 */
export type AgentPresetSource = "custom" | "project" | "ccr" | "registry";

/** A merged preset reduced to what identifies it — never its launch payload. */
export interface AgentPresetIdentity {
  id: string;
  name: string;
  source: AgentPresetSource;
  description?: string;
}

/**
 * Cap on a preset description as it reaches an agent or the UI. Exported so a
 * test asserts truncation against the contract rather than restating a literal.
 */
export const PRESET_DESCRIPTION_MAX_CHARS = 200;

/**
 * Bound a preset's free-form description for agent-facing surfaces.
 *
 * `sanitizePreset` never touches `description`, so it arrives here as raw text
 * from user settings or a `.daintree/presets/*.json` file the repo may not
 * control. Angle brackets are stripped rather than rejected the way
 * `sanitizeDisplayTitle` rejects them: prose legitimately contains "<" and
 * losing a whole description to one character helps nobody.
 */
function sanitizePresetDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = Array.from(value)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // Line breaks and separators become a space rather than vanishing:
      // deleting one silently welds the words on either side into a new one.
      if (code === 0x09 || code === 0x0a || code === 0x0d) return " ";
      if (code === 0x2028 || code === 0x2029) return " ";
      // Remaining C0, DEL and C1 controls carry no text at all.
      if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return "";
      // Half a character. `Array.from` iterates by code point, so an unpaired
      // surrogate surfaces as its own unit here, and it cannot survive JSON.
      if (code >= 0xd800 && code <= 0xdfff) return "";
      // Invisible and direction-altering formatting: zero-width marks, BOM,
      // word joiner, bidi marks, embeddings, overrides and isolates. Their
      // whole function is to make stored text read differently than it is
      // written, which is precisely the hazard for a string that reaches both
      // an agent as prompt text and a person as UI text. Zero-width joiners go
      // with them: losing a compound emoji is a smaller price than keeping a
      // channel for hidden text.
      if (code === 0x061c || code === 0x2060 || code === 0xfeff) return "";
      if (code >= 0x200b && code <= 0x200f) return "";
      if (code >= 0x202a && code <= 0x202e) return "";
      if (code >= 0x2066 && code <= 0x2069) return "";
      return ch;
    })
    .join("")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  // Truncate by code point, not UTF-16 unit: slicing a string mid-surrogate
  // would emit half an emoji as a lone surrogate.
  const points = Array.from(cleaned);
  return points.length > PRESET_DESCRIPTION_MAX_CHARS
    ? points.slice(0, PRESET_DESCRIPTION_MAX_CHARS).join("")
    : cleaned;
}

/**
 * The same merge `getMergedPresets` performs, projected to identity only and
 * tagged with the layer each surviving preset came from.
 *
 * A sibling rather than a widened `getMergedPresets` return type: every one of
 * that function's callers wants launch payloads and none wants provenance.
 * Tagging happens before validation and dedup so the winner of an id collision
 * reports the layer it actually came from rather than the layer that lost.
 *
 * Pass `ccrPresets` exactly as the store holds it. `undefined` means "no CCR
 * data" and keeps the built-in registry bucket; any array — `[]` included —
 * replaces that bucket, matching `getMergedPresets`.
 */
export function getMergedPresetIdentities(
  agentId: string,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[]
): AgentPresetIdentity[] {
  const ccr = presetBucket(ccrPresets);
  const registryPresets = ccr ?? presetBucket(getAgentConfig(agentId)?.presets) ?? [];
  const registrySource: AgentPresetSource = ccr !== undefined ? "ccr" : "registry";

  const tagged: Array<{ preset: AgentPreset; source: AgentPresetSource }> = [
    ...(presetBucket(customPresets) ?? []).map((preset) => ({ preset, source: "custom" as const })),
    ...(presetBucket(projectPresets) ?? []).map((preset) => ({
      preset,
      source: "project" as const,
    })),
    ...registryPresets.map((preset) => ({ preset, source: registrySource })),
  ];

  const seenIds = new Set<string>();
  const result: AgentPresetIdentity[] = [];

  for (const { preset, source } of tagged) {
    const sanitized = sanitizePreset(preset);
    if (!sanitized || seenIds.has(sanitized.id)) continue;
    seenIds.add(sanitized.id);

    const description = sanitizePresetDescription(sanitized.description);
    result.push({
      id: sanitized.id,
      name: sanitized.name,
      source,
      ...(description ? { description } : {}),
    });
  }

  return result;
}

export function getMergedPreset(
  agentId: string,
  presetId: string | undefined,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[]
): AgentPreset | undefined {
  if (presetId !== undefined && !presetId) return undefined;
  const config = getAgentConfig(agentId);
  const merged = getMergedPresets(
    agentId,
    customPresets,
    ccrPresets ?? config?.presets ?? [],
    projectPresets
  );
  if (presetId === undefined) {
    const defaultId = config?.defaultPresetId;
    if (defaultId) return merged.find((f) => f.id === defaultId);
    // No requested preset and no agent-declared default means the bare agent
    // CLI is the default — "Agent default" in the launch dropdown. Returning
    // merged[0] here silently promoted whichever user preset happened to sort
    // first (e.g. a custom Z.AI route) into the primary button's launch, even
    // though the dropdown checkmark sat on "Agent default". Resolve to no
    // preset so the button matches the checkmark.
    return undefined;
  }
  return merged.find((f) => f.id === presetId);
}
