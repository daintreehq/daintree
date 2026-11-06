import { store } from "../store.js";
import { normalizeEditorConfig, type EditorConfig } from "../../shared/types/editor.js";

/**
 * This machine's default editor, or null for automatic selection. A stored
 * value that no longer validates (a hand edit, an editor id since removed)
 * reads as no default rather than failing the launch or the settings page.
 */
export function readDefaultEditor(): EditorConfig | null {
  try {
    const stored = store.get("defaultEditor");
    return stored === undefined ? null : normalizeEditorConfig(stored);
  } catch {
    return null;
  }
}

/** Validates and stores the default. Never touches any project's saved editor. */
export function writeDefaultEditor(editor: unknown): EditorConfig {
  const normalized = normalizeEditorConfig(editor);
  store.set("defaultEditor", normalized);
  return normalized;
}
