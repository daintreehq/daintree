import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { isMarkdownPanel } from "@shared/types/panel";
import { isAbsolute, join, normalize } from "@shared/utils/path";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";

const openPanelArgsSchema = z.object({
  path: z.string().min(1).describe("Absolute or repo-relative path of the markdown file."),
  rootPath: z
    .string()
    .optional()
    .describe(
      "Root used to resolve a relative `path` (a worktree `path` from `worktree.list`). Defaults to the current project root."
    ),
  viewMode: z
    .enum(["rendered", "source"])
    .optional()
    .describe('Initial view mode. Defaults to "rendered".'),
});

function resolveMarkdownPath(path: string, rootPath: string | undefined): string {
  if (isAbsolute(path)) return normalize(path);
  const root = rootPath ?? useProjectStore.getState().currentProject?.path;
  if (!root) {
    throw new Error("No project open — pass an absolute `path` or a `rootPath`");
  }
  return normalize(join(root, path));
}

export function registerMarkdownActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("markdown.openPanel", () => ({
    id: "markdown.openPanel",
    title: "Open Markdown Panel",
    description:
      "Open a markdown file in a markdown viewer panel in the grid (rendered document with a Rendered/Source toggle). Args: `path` (required) — absolute or repo-relative markdown file path; `rootPath` (optional) — root used to resolve a relative `path` (defaults to the current project root); `viewMode` (optional) — 'rendered' (default) or 'source'. Reuses a panel already showing the same file instead of opening a duplicate. Returns { panelId }. Use `file.read` to read a file's content without displaying it.",
    category: "files",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["markdown", "viewer", "preview", "md", "readme", "spec", "document"],
    argsSchema: openPanelArgsSchema,
    examples: [
      {
        args: { path: "docs/spec.md" },
        description: "Open a repo-relative markdown file as a rendered panel",
      },
    ],
    run: async (args: unknown) => {
      const { path, rootPath, viewMode } = openPanelArgsSchema.parse(args);
      const absolutePath = resolveMarkdownPath(path, rootPath);

      const store = usePanelStore.getState();
      const existing = store.panelIds
        .map((id) => store.panelsById[id])
        .find(
          (panel) =>
            panel !== undefined &&
            isMarkdownPanel(panel) &&
            panel.location !== "trash" &&
            panel.markdownFilePath === absolutePath
        );
      if (existing) {
        if (viewMode) store.setMarkdownViewMode(existing.id, viewMode);
        store.activateTerminal(existing.id);
        return { panelId: existing.id };
      }

      // Omit focusPolicy so the store resolves "auto" vs "preserve" via its
      // MCP focus-suppression guard — never steal focus from a typing user.
      const panelId = await store.addPanel({
        kind: "markdown",
        markdownFilePath: absolutePath,
        markdownViewMode: viewMode,
        worktreeId: callbacks.getActiveWorktreeId(),
        location: "grid",
      });
      if (!panelId) {
        throw new Error("Could not open markdown panel: panel limit reached");
      }
      return { panelId };
    },
  }));
}
