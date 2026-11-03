import type {
  AssistantIdentities,
  AssistantIdentityScope,
  DisplayIdentity,
} from "../types/displayIdentity.js";
import { displaySafeText } from "./displaySafeText.js";

/** Longest persona name kept, in graphemes; a longer one is cut. */
export const DISPLAY_NAME_MAX = 80;
/** An emoji sequence longer than this (UTF-16 units) is not one emoji. */
export const DISPLAY_EMOJI_MAX_UNITS = 32;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
// Controls and the formatting characters that reorder or hide text; ZWJ
// (U+200D) is left alone, since family and profession emoji are built with it.
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const UNSAFE_IN_EMOJI = /[\u0000-\u001f\u007f-\u009f؜​‌‎‏‪-‮⁠-⁩﻿]/;

function graphemeList(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

/** A name as it is kept: one line, no controls or bidi overrides, at most {@link DISPLAY_NAME_MAX} graphemes. */
export function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = displaySafeText(value).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const parts = graphemeList(text);
  return parts.length > DISPLAY_NAME_MAX ? parts.slice(0, DISPLAY_NAME_MAX).join("").trimEnd() : text;
}

/** Exactly one emoji (ZWJ sequences, flags, keycaps and skin tones included), or nothing. */
export function normalizeDisplayEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > DISPLAY_EMOJI_MAX_UNITS) return undefined;
  if (UNSAFE_IN_EMOJI.test(text) || !PICTOGRAPHIC.test(text)) return undefined;
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
  return scope.kind === "global"
    ? identities.global
    : (identities.projects[scope.projectId] ?? {});
}
