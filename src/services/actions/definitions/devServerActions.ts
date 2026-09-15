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

      await usePanelStore.getState().addPanel({
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
