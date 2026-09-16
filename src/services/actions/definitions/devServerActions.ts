import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { isAbsolute } from "@shared/utils/path";
import { projectClient } from "@/clients";
import { readDevServerCommand } from "@/utils/devServerCommand";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { isDevPreviewPanel } from "@shared/types/panel";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { getAvailableDevPreviewTool } from "@/registry/devPreviewToolRegistry";
import { actionService } from "@/services/ActionService";

/**
 * Palette gate for `devPreview.stop`: its `run()` needs an open project and a
 * focused dev-preview panel and throws otherwise. Reads the panel store rather
 * than the action context (which doesn't carry the focused panel kind);
 * dispatch never evaluates this, so explicit-arg callers are unaffected.
 */
function isDevPreviewStoppable(ctx: { projectId?: string }): boolean {
  if (!ctx.projectId) return false;
  const { focusedId, getTerminal } = usePanelStore.getState();
  if (!focusedId) return false;
  const panel = getTerminal(focusedId);
  return Boolean(panel && isDevPreviewPanel(panel));
}

/**
 * The dock launcher dispatches this action with the placement its heading
 * advertised (`launchPanelKind`). `ActionService` drops undeclared fields, so
 * without the schema a dock request would silently land in the grid (#12397).
 */
const devServerStartArgsSchema = z
  .object({
    location: z
      .enum(["grid", "dock"])
      .optional()
      .describe("Surface to open on (default: grid). `dock` parks it as a chip in the sidebar."),
    activateDockOnCreate: z
      .boolean()
      .optional()
      .describe("Open the dock popover immediately (default: false). Ignored unless docking."),
  })
  .optional();

type DevServerStartArgs = z.infer<typeof devServerStartArgsSchema>;

/**
 * The created panel's id, so a caller can bind to the preview it just started
 * rather than re-deriving it from the panel list. Null when the panel was
 * rejected or removed during `addPanel`'s async tail.
 */
const devServerStartResultSchema = z
  .object({ panelId: z.string().nullable() })
  .describe("The dev preview panel that was opened");

function readActiveWorktreePath(activeWorktreeId: string | undefined): string | undefined {
  if (!activeWorktreeId) return undefined;
  try {
    return getCurrentViewStore().getState().worktrees.get(activeWorktreeId)?.path;
  } catch {
    return undefined;
  }
}

function firstAbsolutePath(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => typeof candidate === "string" && isAbsolute(candidate));
}

export function registerDevServerActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("devServer.start", () => ({
    id: "devServer.start",
    title: "Open Dev Preview",
    description: "Open a dev preview panel and start the dev server when configured",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: devServerStartArgsSchema,
    resultSchema: devServerStartResultSchema,
    run: async (args: DevServerStartArgs, ctx: ActionContext) => {
      // Grid stays the default, so every caller that predates the dock
      // launcher keeps landing exactly where it did.
      const location = args?.location === "dock" ? "dock" : "grid";
      const currentProject =
        useProjectStore.getState().currentProject ??
        (await projectClient.getCurrent().catch(() => null));
      const projectId = ctx.projectId ?? currentProject?.id;

      // Scratch-owned views have no project, and the dock/palette launcher used
      // to open a dev preview there via the workspace cwd fallback (#11673).
      const devServerCommand = projectId ? await readDevServerCommand(projectId) : undefined;

      const cwd = firstAbsolutePath(
        ctx.activeWorktreePath,
        readActiveWorktreePath(ctx.activeWorktreeId),
        ctx.projectPath,
        currentProject?.path,
        ctx.scratchPath
      );
      if (!cwd) {
        throw new Error("No absolute project path is available for Dev Preview");
      }

      // Returned so a caller that just started a preview can bind to the exact
      // panel it created instead of guessing from the panel list.
      const panelId = await usePanelStore.getState().addPanel({
        kind: "dev-preview",
        title: "Dev Server",
        cwd,
        worktreeId: ctx.activeWorktreeId,
        location,
        // Folded into the same set() that commits the panel, so the offscreen
        // container's watchdog can't close the popover in the render gap (#6590).
        ...(location === "dock" && { activateDockOnCreate: args?.activateDockOnCreate === true }),
        devCommand: devServerCommand,
      });
      return { panelId };
    },
  }));

  actions.set("devPreview.toggleTool", () => ({
    id: "devPreview.toggleTool",
    title: "Toggle Dev Preview Tool",
    description:
      "Switch a plugin-contributed dev preview tool on or off in a dev preview of the active worktree — the focused one, else the first open one — opening a dev preview when the worktree has none. Returns the panel it acted on.",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: { mode: "hidden" },
    argsSchema: z.object({
      toolId: z.string().min(1).describe("The tool's registered id, e.g. a plugin's builder tool."),
      panelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The dev preview to act on. Defaults to the focused or first one in the worktree."
        ),
    }),
    resultSchema: z.object({ panelId: z.string().nullable(), active: z.boolean() }),
    run: async (args: { toolId: string; panelId?: string }, ctx: ActionContext) => {
      // Registration is unconditional for built-ins; only an enabled plugin's
      // tool may start or focus anything.
      if (!getAvailableDevPreviewTool(args.toolId)) {
        throw new Error(
          `No dev preview tool "${args.toolId}" is available — is its plugin enabled?`
        );
      }
      const panels = usePanelStore.getState();
      const isLivePreview = (id: string): boolean => {
        const panel = panels.panelsById[id];
        return panel !== undefined && isDevPreviewPanel(panel) && panel.location !== "trash";
      };
      const inWorktree = (id: string): boolean =>
        isLivePreview(id) &&
        (ctx.activeWorktreeId === undefined ||
          panels.panelsById[id]?.worktreeId === ctx.activeWorktreeId);
      if (args.panelId !== undefined && !isLivePreview(args.panelId)) {
        throw new Error("That panel is not an open dev preview");
      }
      let panelId =
        args.panelId ??
        (panels.focusedId && inWorktree(panels.focusedId) ? panels.focusedId : undefined) ??
        panels.panelIds.find(inWorktree);
      const store = useDevPreviewToolStore.getState();
      // Nested dispatches keep the caller's source, so an agent's call isn't
      // recorded as the user's last action.
      const source = ctx.dispatchSource ?? "user";
      if (!panelId) {
        // Same context as this dispatch, so the preview opens in the worktree
        // the caller targeted rather than whichever one is live by then.
        const started = await actionService.dispatch<{ panelId: string | null }>(
          "devServer.start",
          undefined,
          { source, contextOverride: ctx }
        );
        if (!started.ok || !started.result.panelId) return { panelId: null, active: false };
        panelId = started.result.panelId;
        // The plugin may have been disabled while the preview was starting.
        if (!getAvailableDevPreviewTool(args.toolId)) return { panelId, active: false };
        store.setActive(panelId, args.toolId);
        void actionService.dispatch("panel.focus", { panelId }, { source });
        return { panelId, active: true };
      }
      store.toggle(panelId, args.toolId);
      const active = useDevPreviewToolStore.getState().activeByPanel[panelId] === args.toolId;
      if (active) void actionService.dispatch("panel.focus", { panelId }, { source });
      return { panelId, active };
    },
  }));

  actions.set("devPreview.stop", () => ({
    id: "devPreview.stop",
    title: "Stop Dev Server",
    description: "Stop the currently focused dev preview server",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: {
      mode: "requireContext",
      isReady: (ctx) => isDevPreviewStoppable(ctx),
      reason: "Focus a dev preview to stop it",
    },
    run: async (_args: unknown, ctx: ActionContext) => {
      if (!ctx.projectId) {
        throw new Error("No project is currently open");
      }

      const panelId = ctx.focusedTerminalId;
      if (!panelId) {
        throw new Error("No dev preview panel is focused");
      }

      await window.electron.devPreview.stop({
        panelId,
        projectId: ctx.projectId,
      });
    },
  }));
}
