import { projectStore } from "../../services/ProjectStore.js";
import type { HandlerDependencies } from "../types.js";
import type {
  EditorClearProjectPreferencePayload,
  EditorConfig,
  EditorGetConfigResult,
  EditorSetConfigPayload,
  EditorSetDefaultPayload,
} from "../../../shared/types/editor.js";
import { normalizeEditorConfig, resolveEffectiveEditor } from "../../../shared/types/editor.js";
import { defineIpcNamespace, op } from "../define.js";
import { EDITOR_CONFIG_METHOD_CHANNELS } from "./editorConfig.preload.js";

/** The project's own saved editor; null when it has none or its settings can't be read. */
export async function readProjectEditor(projectId: unknown): Promise<EditorConfig | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  try {
    const settings = await projectStore.getProjectSettings(projectId);
    return settings.preferredEditor ?? null;
  } catch {
    return null;
  }
}

function requireProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || !projectId) {
    throw new Error("projectId is required");
  }
  return projectId;
}

export const editorConfigNamespace = defineIpcNamespace({
  name: "editorConfig",
  ops: {
    getConfig: op(
      EDITOR_CONFIG_METHOD_CHANNELS.getConfig,
      async (projectId?: string): Promise<EditorGetConfigResult> => {
        const [{ discover }, { readDefaultEditor }] = await Promise.all([
          import("../../services/EditorService.js"),
          import("../../services/defaultEditor.js"),
        ]);
        const [discoveredEditors, preferredEditor] = await Promise.all([
          discover(),
          readProjectEditor(projectId),
        ]);
        const defaultEditor = readDefaultEditor();
        return {
          preferredEditor,
          defaultEditor,
          effectiveEditor: resolveEffectiveEditor(preferredEditor, defaultEditor),
          discoveredEditors,
        };
      }
    ),
    setConfig: op(
      EDITOR_CONFIG_METHOD_CHANNELS.setConfig,
      async (payload: EditorSetConfigPayload) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { editor, projectId } = payload as unknown as {
          editor: unknown;
          projectId?: unknown;
        };
        const editorConfig = normalizeEditorConfig(editor);
        const pid = requireProjectId(projectId);

        const settings = await projectStore.getProjectSettings(pid);
        await projectStore.saveProjectSettings(pid, { ...settings, preferredEditor: editorConfig });
      }
    ),
    setDefault: op(
      EDITOR_CONFIG_METHOD_CHANNELS.setDefault,
      async (payload: EditorSetDefaultPayload) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const { writeDefaultEditor } = await import("../../services/defaultEditor.js");
        writeDefaultEditor((payload as unknown as { editor: unknown }).editor);
      }
    ),
    clearProjectPreference: op(
      EDITOR_CONFIG_METHOD_CHANNELS.clearProjectPreference,
      async (payload: EditorClearProjectPreferencePayload) => {
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid payload");
        }
        const pid = requireProjectId((payload as unknown as { projectId?: unknown }).projectId);
        const settings = await projectStore.getProjectSettings(pid);
        if (settings.preferredEditor === undefined) return;
        // Removed rather than set to the default: the project goes back to
        // following whatever the default is, now and after it changes.
        const { preferredEditor: _cleared, ...rest } = settings;
        await projectStore.saveProjectSettings(pid, rest);
      }
    ),
    discover: op(EDITOR_CONFIG_METHOD_CHANNELS.discover, async () => {
      const { discover } = await import("../../services/EditorService.js");
      return discover();
    }),
  },
});

export function registerEditorConfigHandlers(_deps: HandlerDependencies): () => void {
  return editorConfigNamespace.register();
}
