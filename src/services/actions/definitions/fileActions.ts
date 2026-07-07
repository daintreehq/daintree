import { z } from "zod";
import { systemClient } from "@/clients";
import { filesClient } from "@/clients/filesClient";
import { useProjectStore } from "@/store";
import { isAbsolute, isPathInside, join, normalize } from "@shared/utils/path";
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

const readArgsSchema = z.object({
  path: z.string().min(1).describe("Absolute or repo-relative file path to read."),
  rootPath: z
    .string()
    .optional()
    .describe(
      "Repository root used to resolve a relative `path` (a worktree `path` from `worktree.list`). Defaults to the current project root."
    ),
});

const openInEditorArgsSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
});

const openImageViewerArgsSchema = z.object({
  path: z.string(),
});

const showItemInFolderArgsSchema = z.object({
  path: z.string().min(1),
});

export function registerFileActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
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

  actions.set("file.read", () => ({
    id: "file.read",
    title: "Read File",
    description:
      "Read a text file's contents (UTF-8, 500 KB limit). Args: `path` (required) — absolute or repo-relative file path; `rootPath` (optional) — root used to resolve a relative `path` (defaults to the current project root). Only files inside the current project or one of its worktrees are readable — anything else errors. Returns { content }. Errors: BINARY_FILE, FILE_TOO_LARGE (> 500 KB), LFS_POINTER, NOT_FOUND, PERMISSION, outside-project paths. Use `markdown.openPanel` to display a markdown file to the user instead of reading it.",
    category: "files",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: readArgsSchema,
    resultSchema: z.object({ content: z.string() }),
    mcpOutputSchema: true,
    examples: [
      {
        args: { path: "docs/spec.md" },
        description: "Read a repo-relative file's contents",
      },
    ],
    run: async (args: unknown) => {
      const { path, rootPath } = readArgsSchema.parse(args);
      const projectPath = useProjectStore.getState().currentProject?.path;
      const resolutionRoot = rootPath ?? projectPath;
      if (!isAbsolute(path) && !resolutionRoot) {
        throw new Error("No project open — pass an absolute `path` or a `rootPath`");
      }
      const absolutePath = isAbsolute(path)
        ? normalize(path)
        : normalize(join(resolutionRoot!, path));
      // Hard containment: this action is on the MCP/assistant surface, so it
      // must never become an arbitrary-file read. Reads are only allowed
      // inside the current project or one of its worktrees — the containment
      // root is a known root, never derived from the target path.
      const knownRoots = [
        ...(projectPath ? [projectPath] : []),
        ...callbacks.getWorktrees().flatMap((worktree) => (worktree.path ? [worktree.path] : [])),
      ];
      const containingRoot = knownRoots.find((root) => isPathInside(absolutePath, root));
      if (!containingRoot) {
        throw new Error("Path is outside the current project and its worktrees");
      }
      const { content } = await filesClient.read({
        path: absolutePath,
        rootPath: containingRoot,
      });
      return { content };
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

  actions.set("file.showItemInFolder", () => ({
    id: "file.showItemInFolder",
    title: "Reveal in File Manager",
    description:
      "Reveal a file or directory in the OS file manager (Finder on macOS, Explorer on Windows, the default file manager on Linux) with the item selected. Args: `path` (required) — absolute file or directory path. Reveals only; it never opens or launches the item. Errors when the path is missing, outside your project roots, or no longer exists.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: showItemInFolderArgsSchema,
    run: async (args: unknown) => {
      const { path } = showItemInFolderArgsSchema.parse(args);
      await systemClient.showItemInFolder(path);
    },
  }));
}
