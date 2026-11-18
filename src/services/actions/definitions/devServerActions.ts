import { z } from "zod";
import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { usePanelStore } from "@/store/panelStore";
import { isDevPreviewPanel } from "@shared/types/panel";
import { ELEMENT_PICKER_TOOL_ID } from "@/panels/dev-preview/element-picker/toolId";

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

export type DevServerStartArgs = z.infer<typeof devServerStartArgsSchema>;

/**
 * The created panel's id, so a caller can bind to the preview it just started
 * rather than re-deriving it from the panel list. Null when the panel was
 * rejected or removed during `addPanel`'s async tail.
 */
const devServerStartResultSchema = z
  .object({ panelId: z.string().nullable() })
  .describe("The dev preview panel that was opened");

export function registerDevServerActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("devServer.start", () => ({
    id: "devServer.start",
    title: "Open dev preview",
    description: "Open a dev preview panel and start the dev server when configured",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: devServerStartArgsSchema,
    resultSchema: devServerStartResultSchema,
    run: async (args: DevServerStartArgs, ctx: ActionContext) => {
      const { runDevServerStart } = await import("./devServerActions.impl");
      return runDevServerStart(args, ctx);
    },
  }));

  actions.set("devPreview.toggleTool", () => ({
    id: "devPreview.toggleTool",
    title: "Toggle dev preview tool",
    description:
      "Switch a dev preview tool on or off in a dev preview of the active worktree — the focused one, else the first open one — opening a dev preview when the worktree has none. Returns the panel it acted on.",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    palette: { mode: "hidden" },
    argsSchema: z.object({
      toolId: z.string().min(1).describe('The tool\'s id, such as "element-picker".'),
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
      // Read before the chunk loads: focus can move while it does, and the
      // toggle belongs to the preview that was focused when it was asked for.
      const { focusedId } = usePanelStore.getState();
      const { toggleDevPreviewTool } = await import("./devServerActions.impl");
      return toggleDevPreviewTool(args.toolId, args.panelId, ctx, focusedId);
    },
  }));

  actions.set("devPreview.toggleElementPicker", () => ({
    id: "devPreview.toggleElementPicker",
    title: "Toggle element picker",
    description:
      "Switch the Element Picker on or off in the named or focused browser panel (switching on needs a worktree's panel on a page at a local address), else in a dev preview of the active worktree (the focused one, else the first open one), opening one if there is none. It lets the user pick an element on the page and send it to an agent. Returns the panel it acted on and whether the picker is now on.",
    paletteDescription:
      "Turn the Element Picker on or off in the focused browser or the active worktree's dev preview",
    category: "devServer",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: [
      "element",
      "picker",
      "select",
      "inspect",
      "inspector",
      "preview",
      "browser",
      "agent",
    ],
    argsSchema: z
      .object({
        panelId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The dev preview or browser panel to act on. Defaults to the focused browser or dev preview, else the first dev preview in the worktree."
          ),
      })
      .optional(),
    resultSchema: z.object({ panelId: z.string().nullable(), active: z.boolean() }),
    run: async (args: { panelId?: string } | undefined, ctx: ActionContext) => {
      const { focusedId } = usePanelStore.getState();
      const { toggleDevPreviewTool } = await import("./devServerActions.impl");
      return toggleDevPreviewTool(ELEMENT_PICKER_TOOL_ID, args?.panelId, ctx, focusedId, {
        browserPanels: true,
      });
    },
  }));

  actions.set("devPreview.stop", () => ({
    id: "devPreview.stop",
    title: "Stop dev server",
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
      const { runDevPreviewStop } = await import("./devServerActions.impl");
      return runDevPreviewStop(ctx);
    },
  }));
}
