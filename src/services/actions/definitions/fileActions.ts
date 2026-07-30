import { z } from "zod";
import { systemClient } from "@/clients";
import { filesClient } from "@/clients/filesClient";
import { useProjectStore } from "@/store";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { isFilePanel } from "@shared/types/panel";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { isAbsolute, isPathInside, join, normalize, toWorktreeRelative } from "@shared/utils/path";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { isForegroundDispatch } from "./dispatchSource";

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

const openPanelArgsSchema = z.object({
  path: z.string().min(1).describe("Absolute or repo-relative path of the file to display."),
  rootPath: z
    .string()
    .optional()
    .describe(
      "Root used to resolve a relative `path` (a worktree `path` from `worktree.list`). Defaults to the current project root."
    ),
  viewMode: z
    .enum(["rendered", "source"])
    .optional()
    .describe(
      'Initial view mode. Defaults to "source". "rendered" applies to Markdown and HTML files.'
    ),
});

const openInEditorArgsSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
});

const openInBrowserArgsSchema = z.object({
  path: z.string(),
});

const openImageViewerArgsSchema = z.object({
  path: z.string(),
});

const showItemInFolderArgsSchema = z.object({
  path: z.string().min(1),
});

function resolveFilePanelPath(path: string, rootPath: string | undefined): string {
  if (isAbsolute(path)) return normalize(path);
  const root = rootPath ?? useProjectStore.getState().currentProject?.path;
  if (!root) {
    throw new Error("No project open — pass an absolute `path` or a `rootPath`");
  }
  return normalize(join(root, path));
}

export function registerFileActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("file.view", () => ({
    id: "file.view",
    title: "View File",
    description:
      "Open a file in the in-app file viewer dialog (read-only, with optional line scroll). The dialog is ephemeral — it is never persisted, never counts toward the panel limit, and is never restored on restart; use its 'Open as panel' control to keep it in the grid. Args: `path` (required) — absolute or repo-relative file path; `rootPath` (optional) — repo root used to resolve a relative `path`; `line` (optional, positive int) to scroll to a line; `col` (optional, accepted for compatibility, does not affect scrolling). Returns { panelId }. Errors when `path` is missing. Use `file.openPanel` to open directly in the grid, or `file.openInEditor` for the external editor.",
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
      const { path, rootPath, line } = viewArgsSchema.parse(args);
      // Resolve before creating the record, matching file.openPanel: the panel
      // stores an absolute path and has no root to resolve against later.
      const absolutePath = resolveFilePanelPath(path, rootPath);
      // Title the panel with the file name so the dialog header names the file.
      // FilePane derives the same name for its own panel header, but the dialog
      // header reads the stored title through the kind-agnostic host.
      const fileName = absolutePath.split(/[/\\]/).filter(Boolean).pop();
      const panelId = await usePanelDialogStore.getState().openPanelDialog({
        kind: "file",
        filePath: absolutePath,
        worktreeId: callbacks.getActiveWorktreeId(),
        ...(fileName && { title: fileName }),
        ...(line != null && { initialLine: line }),
      });
      if (!panelId) {
        throw new Error("Could not open the file viewer");
      }
      return { panelId };
    },
  }));

  actions.set("file.read", () => ({
    id: "file.read",
    title: "Read File",
    description:
      "Read a text file's contents (UTF-8, 500 KB limit). Args: `path` (required) — absolute or repo-relative file path; `rootPath` (optional) — root used to resolve a relative `path` (defaults to the current project root). Only files inside the current project or one of its worktrees are readable — anything else errors. Returns { content }. Errors: BINARY_FILE, FILE_TOO_LARGE (> 500 KB), LFS_POINTER, NOT_FOUND, PERMISSION, outside-project paths. Use `file.openPanel` to display a file to the user instead of reading it.",
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

  actions.set("file.openPanel", () => ({
    id: "file.openPanel",
    title: "Open File Panel",
    description:
      "Open a file in a read-only file viewer panel in the grid. Markdown and HTML files get a Source/Rendered toggle (source is the default view; rendered HTML shows the page in a sandboxed iframe). Args: `path` (required) — absolute or repo-relative file path; `rootPath` (optional) — root used to resolve a relative `path` (defaults to the current project root); `viewMode` (optional) — 'source' (default) or 'rendered' (Markdown and HTML only). Reuses a panel already showing the same file instead of opening a duplicate. Returns { panelId }. Use `file.read` to read a file's content without displaying it.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["file", "viewer", "panel", "markdown", "html", "preview", "md", "readme", "spec"],
    argsSchema: openPanelArgsSchema,
    examples: [
      {
        args: { path: "docs/spec.md", viewMode: "rendered" },
        description: "Open a repo-relative markdown file as a rendered document panel",
      },
      {
        args: { path: "dist/report.html", viewMode: "rendered" },
        description: "Render a generated HTML report in a sandboxed iframe",
      },
      {
        args: { path: "src/index.css" },
        description: "Pin any repo file into the grid as a source view",
      },
    ],
    run: async (args: unknown, ctx?: ActionContext) => {
      const { path, rootPath, viewMode } = openPanelArgsSchema.parse(args);
      const absolutePath = resolveFilePanelPath(path, rootPath);
      // "rendered" applies only to Markdown and HTML — clamp so a stray request
      // can't persist a mode the panel can never display.
      const effectiveViewMode =
        viewMode === "rendered" &&
        !isMarkdownFilePath(absolutePath) &&
        !isHtmlFilePath(absolutePath)
          ? "source"
          : viewMode;

      const store = usePanelStore.getState();
      const existing = store.panelIds
        .map((id) => store.panelsById[id])
        .find(
          (panel) =>
            panel !== undefined &&
            isFilePanel(panel) &&
            // Trashed panels are pending cleanup, background panels are
            // hibernated mirrors, and dialog panels are ephemeral modal
            // content — activating any of them surfaces nothing, and reusing a
            // dialog panel here would hand the grid an uncounted, unpersisted
            // record instead of opening a real panel.
            panel.location !== "trash" &&
            panel.location !== "background" &&
            panel.location !== "dialog" &&
            panel.filePath === absolutePath
        );
      if (existing) {
        if (effectiveViewMode) store.setFileViewMode(existing.id, effectiveViewMode);
        store.activateTerminal(existing.id);
        return { panelId: existing.id };
      }

      // A person asking for a file expects to see it, so a foreground dispatch
      // takes focus outright — that policy is also the one that leaves
      // fullscreen, so the panel can't land buried behind a maximized cell
      // (#11506). Agent/plugin dispatches omit focusPolicy entirely and keep
      // the store's "auto" vs "preserve" resolution, so a background open still
      // never steals focus from a typing user.
      const panelId = await store.addPanel({
        kind: "file",
        filePath: absolutePath,
        fileViewMode: effectiveViewMode,
        worktreeId: callbacks.getActiveWorktreeId(),
        location: "grid",
        ...(isForegroundDispatch(ctx?.dispatchSource) && { focusPolicy: "take" as const }),
      });
      if (!panelId) {
        throw new Error("Could not open file panel: panel limit reached");
      }
      return { panelId };
    },
  }));

  actions.set("file.openDiff", () => ({
    id: "file.openDiff",
    title: "Open Diff",
    description:
      "Open a file's working-tree diff in the in-app side-by-side diff viewer dialog. The dialog is ephemeral — it is never persisted, never counts toward the panel limit, and is never restored on restart; use its 'Open as panel' control to keep it in the grid. Args: `path` (required) — absolute or repo-relative file path; `worktreePath` (optional) — worktree root the diff is computed against (defaults to the current project path); `status` (optional git status, defaults to `modified`). Returns { panelId }. Use `file.view` for a read-only file view without a diff.",
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
      // The panel resolves its worktree root from `worktreeId`, so pass the
      // path through relative — an absolute one would defeat that resolution.
      const relativePath = toWorktreeRelative(path, resolvedWorktreePath);
      const fileName = relativePath.split(/[/\\]/).filter(Boolean).pop();
      const panelId = await usePanelDialogStore.getState().openPanelDialog({
        kind: "diff",
        filePath: relativePath,
        fileStatus: status ?? "modified",
        diffSource: "working-tree",
        worktreeId: callbacks.getActiveWorktreeId(),
        ...(fileName && { title: fileName }),
      });
      if (!panelId) {
        throw new Error("Could not open the diff viewer");
      }
      return { panelId };
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

  actions.set("file.openInBrowser", () => ({
    id: "file.openInBrowser",
    title: "Open in Browser",
    description:
      "Open a file with the OS default handler for its type — for HTML files this is the default web browser. Args: `path` (required) — absolute file path. Use `file.openInEditor` to open in the external editor instead.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: openInBrowserArgsSchema,
    run: async (args: unknown) => {
      const { path } = openInBrowserArgsSchema.parse(args);
      await systemClient.openPath(path);
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
