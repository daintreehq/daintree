import { z } from "zod";
import { systemClient } from "@/clients";
import { useProjectStore } from "@/store";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

const viewArgsSchema = z.object({
  path: z.string().describe("Absolute or repo-relative file path to open."),
  rootPath: z
    .string()
    .optional()
    .describe(
      "Repository root used to resolve a relative `path` (a worktree `path` from `worktree.list`)."
    ),
  line: z.number().int().positive().optional().describe("1-based line to scroll to."),
  col: z.number().int().positive().optional().describe("1-based column to scroll to."),
});

const openDiffArgsSchema = z.object({
  path: z.string().describe("Absolute or repo-relative file path to diff."),
  worktreePath: z
    .string()
    .optional()
    .describe(
      "Worktree root the diff is computed against. Falls back to the current project path when omitted."
    ),
  status: z
    .enum([
      "modified",
      "added",
      "deleted",
      "untracked",
      "renamed",
      "copied",
      "ignored",
      "conflicted",
    ])
    .optional()
    .describe("Git status of the path; defaults to `modified` when omitted."),
});

const openInEditorArgsSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
});

const openImageViewerArgsSchema = z.object({
  path: z.string(),
});

export function registerFileActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("file.view", () => ({
    id: "file.view",
    title: "View File",
    description:
      "Open a file in the in-app file viewer modal (read-only, with optional line/column scroll). Args: `path` (required) — absolute or repo-relative file path; `rootPath` (optional) — repo root used to resolve a relative `path`; `line`/`col` (optional, positive ints) to scroll to a location. Returns nothing (fires the viewer event). Errors when `path` is missing. Use `file.openInEditor` instead to open in the external editor.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: viewArgsSchema,
    examples: [
      {
        args: { path: "src/services/ActionService.ts" },
        description: "View a repo-relative file in the in-app viewer",
      },
      {
        args: { path: "src/index.css", line: 1084 },
        description: "Open a file scrolled to a specific line",
      },
    ],
    run: async (args: unknown) => {
      const { path, rootPath, line, col } = args as z.infer<typeof viewArgsSchema>;
      window.dispatchEvent(
        new CustomEvent("daintree:view-file", {
          detail: { path, rootPath, line, col },
        })
      );
    },
  }));

  actions.set("file.openDiff", () => ({
    id: "file.openDiff",
    title: "Open Diff",
    description:
      "Open a file's working-tree diff in the in-app side-by-side diff viewer. Args: `path` (required) — absolute or repo-relative file path; `worktreePath` (optional) — worktree root the diff is computed against (defaults to the current project path); `status` (optional git status, defaults to `modified`). Returns nothing (fires the diff-viewer event). Use `file.view` for a read-only file view without a diff.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openDiffArgsSchema,
    examples: [
      {
        args: { path: "src/services/ActionService.ts" },
        description: "Open the working-tree diff for a modified file",
      },
    ],
    run: async (args: unknown) => {
      const { path, worktreePath, status } = openDiffArgsSchema.parse(args);
      const resolvedWorktreePath = worktreePath ?? useProjectStore.getState().currentProject?.path;
      window.dispatchEvent(
        new CustomEvent("daintree:view-diff", {
          detail: { path, worktreePath: resolvedWorktreePath, status: status ?? "modified" },
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

  actions.set("file.openImageViewer", () => ({
    id: "file.openImageViewer",
    title: "Open in Image Viewer",
    description: "Open an image file in the system image viewer or a configured custom viewer",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openImageViewerArgsSchema,
    run: async (args: unknown) => {
      const { path } = args as z.infer<typeof openImageViewerArgsSchema>;
      await systemClient.openPath(path);
    },
  }));
}
