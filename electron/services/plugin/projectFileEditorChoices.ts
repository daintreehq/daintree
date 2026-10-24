// eager-import-allow: reads project file-editor choices via store.get so changing one file-type answer preserves every other saved choice
import { store } from "../../store.js";
import {
  isFileEditorChoice,
  isFileEditorChoiceKey,
  type FileEditorChoice,
  type FileEditorChoiceKey,
  type FileEditorChoices,
} from "../../../shared/types/plugin.js";

/**
 * Each project's "Edit with…" answers (#13809): which file editor opens a
 * file type's Edit or Rendered mode when more than one matches.
 *
 * Daintree's own settings, never the repository, so a project plugin cannot
 * pre-answer for the user. An answer naming an editor that has since gone is
 * kept rather than pruned: the renderer falls back while it is absent, and the
 * answer applies again if the plugin comes back.
 *
 * No in-memory copy, as in `projectSurfaceChoices.ts`: reads happen on a
 * view's first file panel and writes on a click.
 */
const STORE_KEY = "projectFileEditorChoices";

/** The file is user-editable, so every entry is checked and anything malformed is skipped. */
function parseChoices(value: unknown): FileEditorChoices {
  const choices: Record<FileEditorChoiceKey, FileEditorChoice> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return choices;
  for (const [key, choice] of Object.entries(value as Record<string, unknown>)) {
    if (isFileEditorChoiceKey(key) && isFileEditorChoice(choice)) choices[key] = choice;
  }
  return choices;
}

function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

export function getProjectFileEditorChoices(projectId: string): FileEditorChoices {
  return parseChoices(readAll()[projectId]);
}

/** Remember (or, with `null`, forget) one answer for `projectId`. Returns the project's answers. */
export function setProjectFileEditorChoice(
  projectId: string,
  key: FileEditorChoiceKey,
  choice: FileEditorChoice | null
): FileEditorChoices {
  const all = readAll();
  const next: Record<string, FileEditorChoice> = { ...parseChoices(all[projectId]) };
  if (choice === null) delete next[key];
  else next[key] = choice;
  const updated = { ...all };
  if (Object.keys(next).length === 0) delete updated[projectId];
  else updated[projectId] = next;
  store.set(STORE_KEY, updated);
  return next;
}
