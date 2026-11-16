import type { ProjectDisplayIdentity } from "../types/ipc/projectMatch.js";

// Stored names have no cap of their own; this is the bound the link already
// puts on a source's project name. The emoji cap is the creation dialog's.
export const MAX_DISPLAY_NAME_LENGTH = 1024;
export const MAX_DISPLAY_EMOJI_LENGTH = 32;
// A colour is a token or a gradient; anything longer is not one.
export const MAX_DISPLAY_COLOR_LENGTH = 256;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

function plain(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * A project's name, emoji and colour as another host sent them: kept only
 * when the name and emoji are plain bounded strings. A malformed colour is
 * read as none rather than costing the rest.
 */
export function normalizeProjectDisplay(value: unknown): ProjectDisplayIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = plain(record.name, MAX_DISPLAY_NAME_LENGTH);
  const emoji = plain(record.emoji, MAX_DISPLAY_EMOJI_LENGTH);
  if (name === null || emoji === null) return null;
  return { name, emoji, color: plain(record.color, MAX_DISPLAY_COLOR_LENGTH) };
}
