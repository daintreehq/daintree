import {
  PLUGIN_WORKTREE_DELETE_NOTES_MAX,
  PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX,
  type PluginWorktreeDeleteNote,
} from "../types/plugin.js";
import { readField } from "./pluginWorktreeCardStatus.js";

export type PluginWorktreeDeleteNotesResult =
  { ok: true; notes: PluginWorktreeDeleteNote[] } | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["severity", "text"]);

// Tabs and line and paragraph separators become spaces, so a note stays one line.
const LINE_BREAKS = /[\t\r\n\u0085\u2028\u2029]+/g;
// Every other C0 and C1 control, plus the bidi embeddings, overrides,
// isolates and marks that could make a note read differently from what it says.
// eslint-disable-next-line no-control-regex -- stripping controls is the point
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Past this a note can't fit however much of it is whitespace or invisible, so
// it is refused before any of the work below is spent on it.
const RAW_TEXT_MAX = PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX * 8;

// Normalized last: stripping a control can leave two halves of a composed
// character next to each other.
function cleanText(text: string): string {
  return text
    .replace(LINE_BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

/**
 * Vet a `provideNotes` answer (#13805) and return a fresh plain copy. The whole
 * answer is refused rather than trimmed to fit, so a fourth note can't quietly
 * drop the warning the plugin put last. `[]` is an answer: nothing to say.
 */
export function validatePluginWorktreeDeleteNotes(value: unknown): PluginWorktreeDeleteNotesResult {
  if (!Array.isArray(value)) return { ok: false, error: "notes must be an array" };
  if (value.length > PLUGIN_WORKTREE_DELETE_NOTES_MAX) {
    return {
      ok: false,
      error: `notes must hold at most ${PLUGIN_WORKTREE_DELETE_NOTES_MAX} notes`,
    };
  }
  const notes: PluginWorktreeDeleteNote[] = [];
  for (let index = 0; index < value.length; index++) {
    const note: unknown = Object.getOwnPropertyDescriptor(value, index)?.value;
    const at = `notes[${index}]`;
    if (typeof note !== "object" || note === null || Array.isArray(note)) {
      return { ok: false, error: `${at} must be an object with a severity and a text` };
    }
    const unknownKey = Object.keys(note).find((key) => !ALLOWED_KEYS.has(key));
    if (unknownKey !== undefined) {
      return { ok: false, error: `${at} has an unsupported field "${unknownKey}"` };
    }
    const severity = readField(note, "severity");
    const text = readField(note, "text");
    if (severity !== "warning" && severity !== "info") {
      return { ok: false, error: `${at}.severity must be "warning" or "info"` };
    }
    if (typeof text !== "string") return { ok: false, error: `${at}.text must be a string` };
    if (text.length > RAW_TEXT_MAX) {
      return {
        ok: false,
        error: `${at}.text must be at most ${PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX} characters`,
      };
    }
    const cleaned = cleanText(text);
    if (cleaned.length === 0) return { ok: false, error: `${at}.text must not be empty` };
    if ([...cleaned].length > PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX) {
      return {
        ok: false,
        error: `${at}.text must be at most ${PLUGIN_WORKTREE_DELETE_NOTE_TEXT_MAX} characters`,
      };
    }
    notes.push({ severity, text: cleaned });
  }
  return { ok: true, notes };
}
