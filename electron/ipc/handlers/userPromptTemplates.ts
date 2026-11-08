import { defineIpcNamespace, op } from "../define.js";
import { USER_PROMPT_TEMPLATES_METHOD_CHANNELS } from "./userPromptTemplates.preload.js";
import { openWithDefaultApp } from "../../utils/openPath.js";
import type {
  UserPromptTemplatesFolderResult,
  UserPromptTemplatesSnapshot,
} from "../../../shared/types/ipc/userPromptTemplates.js";

// Loaded on first use: nothing reads the folder until someone opens a `/` menu.
const loadService = () => import("../../services/userPromptTemplates.js");

export const userPromptTemplatesNamespace = defineIpcNamespace({
  name: "userPromptTemplates",
  ops: {
    list: op(
      USER_PROMPT_TEMPLATES_METHOD_CHANNELS.list,
      async (): Promise<UserPromptTemplatesSnapshot> => {
        const { readUserPromptTemplates } = await loadService();
        return readUserPromptTemplates();
      }
    ),
    openFolder: op(
      USER_PROMPT_TEMPLATES_METHOD_CHANNELS.openFolder,
      async (): Promise<UserPromptTemplatesFolderResult> => {
        const { ensureUserPromptTemplatesDir, getUserPromptTemplatesDir } = await loadService();
        const directory = getUserPromptTemplatesDir();
        try {
          await ensureUserPromptTemplatesDir(directory);
        } catch (err) {
          console.warn("[userPromptTemplates] Failed to create the templates folder:", err);
          return { directory, opened: false };
        }
        const openError = await openWithDefaultApp(directory);
        if (openError) {
          console.warn("[userPromptTemplates] Failed to open the templates folder:", openError);
        }
        return { directory, opened: openError === "" };
      }
    ),
  },
});

export function registerUserPromptTemplatesHandlers(): () => void {
  return userPromptTemplatesNamespace.register();
}
