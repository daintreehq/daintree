import { z } from "zod";
import { systemClient } from "@/clients";
import { useProjectStore } from "@/store";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

const viewArgsSchema = z.object({
  path: z.string(),
  rootPath: z.string().optional(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
});

const openInEditorArgsSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
});

export function registerFileActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("file.view", () => ({
    id: "file.view",
    title: "View File",
    description: "Open a file in the in-app file viewer modal",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: viewArgsSchema,
    run: async (args: unknown) => {
      const { path, rootPath, line, col } = args as z.infer<typeof viewArgsSchema>;
      window.dispatchEvent(
        new CustomEvent("canopy:view-file", {
          detail: { path, rootPath, line, col },
        })
      );
    },
  }));

  actions.set("file.openInEditor", () => ({
    id: "file.openInEditor",
    title: "Open in Editor",
    description: "Open a file in the configured external editor at an optional line/column",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openInEditorArgsSchema,
    run: async (args: unknown) => {
      const { path, line, col } = args as z.infer<typeof openInEditorArgsSchema>;
      const projectId = useProjectStore.getState().currentProject?.id;
      await systemClient.openInEditor({ path, line, col, projectId });
    },
  }));
}
