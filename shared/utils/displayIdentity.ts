import type {
  AssistantIdentities,
  AssistantIdentityScope,
  DisplayIdentity,
} from "../types/displayIdentity.js";

/** Longest persona name kept, in graphemes; a longer one is cut. */
export const DISPLAY_NAME_MAX = 80;
/** An emoji sequence longer than this (UTF-16 units) is not one emoji. */
export const DISPLAY_EMOJI_MAX_UNITS = 32;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// The formatting characters that reorder or hide text. ZWJ (U+200D) is not one
// of them here: family and profession emoji are built with it.
const HIDDEN_FORMATTING = /[\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function graphemeList(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

/** A name as it is kept: one line, no controls or bidi overrides, at most {@link DISPLAY_NAME_MAX} graphemes. */
export function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(CONTROLS, " ")
    .replace(HIDDEN_FORMATTING, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  const parts = graphemeList(text);
  return parts.length > DISPLAY_NAME_MAX
    ? parts.slice(0, DISPLAY_NAME_MAX).join("").trimEnd()
    : text;
}

/** Exactly one emoji (ZWJ sequences, flags, keycaps and skin tones included), or nothing. */
export function normalizeDisplayEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Checked before the trim, which would otherwise take a newline or tab away
  // and let the rest through.
  if (value.replace(CONTROLS, "").replace(HIDDEN_FORMATTING, "") !== value) return undefined;
  const text = value.trim();
  if (!text || text.length > DISPLAY_EMOJI_MAX_UNITS) return undefined;
  if (!PICTOGRAPHIC.test(text)) return undefined;
  return graphemeList(text).length === 1 ? text : undefined;
}

/** A persona read from anywhere: unknown fields dropped, invalid ones unset. */
export function normalizeDisplayIdentity(value: unknown): DisplayIdentity {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const name = normalizeDisplayName(record.name);
  const emoji = normalizeDisplayEmoji(record.emoji);
  return { ...(name !== undefined && { name }), ...(emoji !== undefined && { emoji }) };
}

export function isEmptyDisplayIdentity(identity: DisplayIdentity | null | undefined): boolean {
  return !identity?.name && !identity?.emoji;
}

/** The persona's name, or the surface's own label when it has none. */
export function displayIdentityName(
  identity: DisplayIdentity | null | undefined,
  fallback: string
): string {
  return identity?.name || fallback;
}

/** Emoji and name as one string, for text-only surfaces: notifications, tooltips, accessible names. */
export function displayIdentityLabel(
  identity: DisplayIdentity | null | undefined,
  fallback: string
): string {
  const name = displayIdentityName(identity, fallback);
  return identity?.emoji ? `${identity.emoji} ${name}` : name;
}

/** A panel's emoji in front of its title, for text-only surfaces. */
export function withDisplayEmoji(title: string, emoji: string | null | undefined): string {
  return emoji ? `${emoji} ${title}` : title;
}

export const EMPTY_ASSISTANT_IDENTITIES: AssistantIdentities = { global: {}, projects: {} };

export function assistantIdentityFor(
  identities: AssistantIdentities | null | undefined,
  scope: AssistantIdentityScope
): DisplayIdentity {
  if (!identities) return {};
  if (scope.kind === "global") return identities.global;
  // Own entries only: a project id like "constructor" must not read Object's.
  return Object.hasOwn(identities.projects, scope.projectId)
    ? (identities.projects[scope.projectId] ?? {})
    : {};
}
