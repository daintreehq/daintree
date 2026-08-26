import { z } from "zod";
import { systemClient } from "@/clients";
import { filesClient } from "@/clients/filesClient";
import { useProjectStore } from "@/store";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { isFilePanel, type FileViewMode } from "@shared/types/panel";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { isHtmlFilePath } from "@/components/Html/isHtmlFile";
import { isAbsolute, isPathInside, join, normalize, toWorktreeRelative } from "@shared/utils/path";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { isClientAppError } from "@/utils/clientAppError";
import { isForegroundDispatch } from "./dispatchSource";
import { PANEL_LIMIT_ERROR_SUFFIX } from "./panelLimitError";

const viewArgsSchema = z.object({
  path: z.string().describe("Absolute or repo-relative file path to open."),
  rootPath: z
    .string()
    .optional()
    .describe(
      "Repository root that a relative path is resolved against — use a worktree root from the worktree-listing capability."
    ),
  worktreeId: z
    .string()
    .optional()
    .describe("Worktree the panel belongs to; defaults to the active one."),
  viewMode: z
    .enum(["rendered", "source"])
    .optional()
    .describe('Initial view mode; defaults to "source". "rendered" applies to Markdown and HTML.'),
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
      "Repository root that a relative path is resolved against — use a worktree root from the worktree-listing capability. Defaults to the current project root."
    ),
});

const openPanelArgsSchema = z.object({
  path: z.string().min(1).describe("Absolute or repo-relative path of the file to display."),
  rootPath: z
    .string()
    .optional()
    .describe(
      "Root that a relative path is resolved against — use a worktree root from the worktree-listing capability. Defaults to the current project root."
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
  allowOutsideRoots: z.boolean().default(false),
});

/**
 * "rendered" applies only to Markdown and HTML — clamp so a stray request can't
 * persist a mode the panel can never display. Shared by the dialog and grid
 * openers so both answer the same way for the same path.
 */
function resolveFileViewMode(
  absolutePath: string,
  viewMode: FileViewMode | undefined
): FileViewMode | undefined {
  if (viewMode !== "rendered") return viewMode;
  return isMarkdownFilePath(absolutePath) || isHtmlFilePath(absolutePath) ? viewMode : "source";
}

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
      "Show a file to the user in a temporary read-only viewer dialog, optionally scrolled to a line. The dialog is deliberately ephemeral — it is never restored on restart. Open it as a grid panel instead when it should persist, or read the file directly when the content is for you rather than the user. This displays a file; it does not return its contents.",
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
      const { path, rootPath, worktreeId, viewMode, line } = viewArgsSchema.parse(args);
      // Resolve before creating the record, matching file.openPanel: the panel
      // stores an absolute path and has no root to resolve against later.
      const absolutePath = resolveFilePanelPath(path, rootPath);
      const effectiveViewMode = resolveFileViewMode(absolutePath, viewMode);
      // Title the panel with the file name so the dialog header names the file.
      // FilePane derives the same name for its own panel header, but the dialog
      // header reads the stored title through the kind-agnostic host.
      const fileName = absolutePath.split(/[/\\]/).filter(Boolean).pop();
      const panelId = await usePanelDialogStore.getState().openPanelDialog({
        kind: "file",
        filePath: absolutePath,
        // An explicit id wins over the active worktree: a caller opening a file
        // for a specific worktree (a sidebar card that isn't the selected one)
        // would otherwise stamp the panel with a worktree the file isn't in,
        // which is what decides its read root and where a promotion lands.
        worktreeId: worktreeId ?? callbacks.getActiveWorktreeId(),
        ...(fileName && { title: fileName }),
        ...(effectiveViewMode && { fileViewMode: effectiveViewMode }),
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
      "Read a text file's contents. Only files inside the current project or one of its worktrees are readable — anything outside fails, so this cannot reach arbitrary paths on the machine. Files that are binary, too large, or stored as large-file pointers fail with a specific reason rather than returning partial text. Open a viewer panel instead when the goal is to show the file to the user.",
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
      "Show a file to the user in a persistent read-only panel in the grid. Markdown and HTML can be shown as source or rendered, with rendered HTML sandboxed. It reuses an existing grid or dock panel showing the same file rather than duplicating it, but will not revive a trashed or backgrounded one. Read the file directly when the content is for you rather than the user.",
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
      const effectiveViewMode = resolveFileViewMode(absolutePath, viewMode);

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
        // Composed from the shared suffix rather than spelled out, so the
        // dispatchers that stay quiet about an already-reported refusal keep
        // recognising this one when either side is reworded.
        throw new Error(`Could not open file panel: ${PANEL_LIMIT_ERROR_SUFFIX}`);
      }
      return { panelId };
    },
  }));

  actions.set("file.openDiff", () => ({
    id: "file.openDiff",
    title: "Open Diff",
    description:
      "Open a file's working-tree diff in the in-app side-by-side diff viewer dialog. The dialog is ephemeral — it is never persisted, never counts toward the panel limit, and is never restored on restart; use its 'Open as panel' control to keep it in the grid. Args: `path` (required) — absolute or repo-relative file path; `worktreePath` (optional) — worktree root the diff is computed against (defaults to the current project path); `status` (optional git status, defaults to `modified`). Returns { panelId }. Open a plain file viewer instead when no diff is wanted.",
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
    description:
      "Open a file in the user's configured external editor, optionally at a line. This hands off to another application on the user's machine and returns nothing about the file. Read the file directly, or open an in-app viewer panel, when the content is needed here rather than by the user.",
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
      "Open a file with the OS default handler for its type — for HTML files this is the default web browser. Args: `path` (required) — absolute file path. Open the file in the configured external editor instead when that is what you want.",
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
      "Reveal a file or directory in the OS file manager (Finder on macOS, Explorer on Windows, the default file manager on Linux) with the item selected. Args: `path` (required) — absolute file or directory path; `allowOutsideRoots` (optional, default false) — when containment refuses the path, retry through a guarded fallback that skips project-root containment but still refuses executable targets, so it cannot reveal everything a root-contained reveal can. Plugins may not set it. Reveals only; it never opens or launches the item. Errors when the path is missing, no longer exists, or sits outside your project roots without `allowOutsideRoots`.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: showItemInFolderArgsSchema,
    run: async (args: unknown, ctx?: ActionContext) => {
      const { path, allowOutsideRoots } = showItemInFolderArgsSchema.parse(args);

      // The plugin system gates its own reveal capability; letting a plugin set
      // the flag would hand it the unconfined op for free. Refused ahead of the
      // confined call so it is the flag being rejected, not the reveal — a
      // plugin dispatching `{ path }` keeps today's contained behavior. Plain
      // `Error` rather than an AppError, mirroring the recipe-terminal gate in
      // `workflowCreationActions.ts`.
      if (allowOutsideRoots && ctx?.dispatchSource === "plugin") {
        throw new Error(
          "Plugins cannot reveal paths outside your project roots. Dispatch file.showItemInFolder without `allowOutsideRoots`."
        );
      }

      try {
        await systemClient.showItemInFolder(path);
      } catch (error) {
        // Flag first so a caller that never opted in gets an untouched rethrow:
        // `isClientAppError` decodes by mutating the error in place. Then the
        // decode, which is the only sound read of the discriminant — contextBridge
        // strips the error's own `code`/`name` on the way to the renderer, leaving
        // the encoded message prefix as the sole carrier (#6116). Narrowed to the
        // exact containment rejection: INVALID_PATH, a denied extension, or any
        // other failure must never reach the relaxed op.
        if (!allowOutsideRoots || !isClientAppError(error) || error.code !== "OUTSIDE_ROOT") {
          throw error;
        }
        // Deliberately not wrapped: a rejection here is the user's answer, and
        // the unconfined op keeps its own deny-list, realpath and stat guards.
        await systemClient.showItemInFolderUnconfined(path);
      }
    },
  }));
}
