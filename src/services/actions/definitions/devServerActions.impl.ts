// The dev server and dev preview actions' run bodies, loaded on first dispatch by
// devServerActions.ts, which keeps the metadata every view registers at boot.
// Nothing here may import devServerActions.ts at runtime.
import type { ActionContext } from "@shared/types/actions";
import { isAbsolute } from "@shared/utils/path";
import { projectClient } from "@/clients";
import { readDevServerCommand } from "@/utils/devServerCommand";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { isBrowserPanel, isDevPreviewPanel } from "@shared/types/panel";
import { isPickablePageUrl } from "@shared/elementPicker/originPolicy";
import { panelMatchesWorktreeScope } from "@/store/slices/panelRegistry/worktreeIndex";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import type {
  DevPreviewToolContext,
  DevPreviewToolDefinition,
} from "@/services/devPreviewTools/types";
import {
  seedDevPreviewToolContext,
  startDevPreviewToolSessions,
} from "@/services/devPreviewTools/sessionManager";
import { resolveDevPreviewTool } from "@/services/devPreviewTools/builtInTools";
import { actionService } from "@/services/ActionService";
import type { DevServerStartArgs } from "./devServerActions";

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

/**
 * What a command can tell a tool's availability predicate about a preview. The
 * page and its readiness are the pane's to know — a command runs wherever it was
 * dispatched from — so this carries the last URL the panel recorded and reports
 * the webview as not ready. A predicate whose answer turns on the live page must
 * treat that as "not yet", which is what the toolbar button already does.
 */
function devPreviewToolContext(panelId: string, ctx: ActionContext): DevPreviewToolContext {
  const panel = usePanelStore.getState().panelsById[panelId];
  const hosts = panel !== undefined && (isDevPreviewPanel(panel) || isBrowserPanel(panel));
  const worktreeId = (hosts ? panel.worktreeId : undefined) ?? null;
  return {
    panelId,
    projectId: ctx.projectId ?? null,
    worktreeId,
    worktreePath: (worktreeId ? readActiveWorktreePath(worktreeId) : undefined) ?? null,
    url:
      (panel && isDevPreviewPanel(panel)
        ? (panel.browserUrl ?? panel.devServerUrl)
        : panel && isBrowserPanel(panel)
          ? panel.browserUrl
          : "") ?? "",
    isWebviewReady: false,
  };
}

/**
 * The same answer the toolbar button gets, so a palette or an agent can never
 * switch on a tool the button is hiding. The tool owns the refusal's wording.
 */
async function refuseUnlessToolApplies(
  tool: DevPreviewToolDefinition,
  panelId: string,
  ctx: ActionContext
): Promise<void> {
  const isAvailable = tool.isAvailable;
  if (!isAvailable) return;
  const asked = devPreviewToolContext(panelId, ctx);
  // Inside the chain: a predicate that throws synchronously is a refusal with
  // the tool's own wording, not an unhandled error from the action.
  const applies = await Promise.resolve()
    .then(() => isAvailable(asked))
    .catch(() => false);
  // Detection takes a round trip, and the preview can move worktrees inside it.
  // An answer about the worktree we no longer have is not an answer.
  if (applies && devPreviewToolContext(panelId, ctx).worktreePath !== asked.worktreePath) {
    throw new Error(`${tool.label} is no longer about this preview's worktree — try again`);
  }
  if (!applies) {
    throw new Error(tool.unavailableReason ?? `${tool.label} does not apply to this dev preview`);
  }
}

/**
 * Switch a tool on or off in a browser panel: only ever the one named or
 * focused, since a browser is somewhere the user went, not something a command
 * opens. Switching on needs the page the panel last recorded to be one the
 * picker installs into; switching off is always allowed.
 */
async function toggleBrowserTool(
  tool: DevPreviewToolDefinition,
  panelId: string,
  ctx: ActionContext,
  source: NonNullable<ActionContext["dispatchSource"]>
): Promise<{ panelId: string; active: boolean }> {
  const store = useDevPreviewToolStore.getState();
  if (store.activeByPanel[panelId] !== tool.id) {
    const context = devPreviewToolContext(panelId, ctx);
    if (!isPickablePageUrl(context.url)) {
      throw new Error(
        `${tool.label} works only on a page at a local address, and this browser panel isn't showing one`
      );
    }
    // A worktree-less browser (a global one in the dock) has no checkout to
    // trace into and no agents of its own to hand a selection to.
    if (context.worktreeId === null) {
      throw new Error(`${tool.label} needs a browser panel that belongs to a worktree`);
    }
    await refuseUnlessToolApplies(tool, panelId, ctx);
    seedDevPreviewToolContext(devPreviewToolContext(panelId, ctx));
  }
  useDevPreviewToolStore.getState().toggle(panelId, tool.id);
  const active = useDevPreviewToolStore.getState().activeByPanel[panelId] === tool.id;
  if (active) void actionService.dispatch("panel.focus", { panelId }, { source });
  return { panelId, active };
}

/**
 * Switch a tool on or off in a dev preview of the active worktree — the one
 * named, else the focused one, else the first open one — opening a preview when
 * the worktree has none. Returns the panel it acted on and what the store now
 * says, never what was asked.
 *
 * With `browserPanels`, a browser panel counts too, ahead of any preview: the
 * one named, or the focused one, since the page in front of the user is the
 * one they mean.
 */
export async function toggleDevPreviewTool(
  toolId: string,
  requestedPanelId: string | undefined,
  ctx: ActionContext,
  focusedId: string | null,
  options: { browserPanels?: boolean } = {}
): Promise<{ panelId: string | null; active: boolean }> {
  // A command can switch a tool on before any preview pane has mounted —
  // the pane is what normally starts the session manager — and the tool
  // would then sit switched on with no session behind it until one did.
  startDevPreviewToolSessions();
  const tool = resolveDevPreviewTool(toolId);
  if (!tool) {
    throw new Error(`No dev preview tool "${toolId}" exists`);
  }
  const panels = usePanelStore.getState();
  const isLivePreview = (id: string): boolean => {
    const panel = panels.panelsById[id];
    return panel !== undefined && isDevPreviewPanel(panel) && panel.location !== "trash";
  };
  const isLiveBrowser = (id: string): boolean => {
    if (options.browserPanels !== true) return false;
    const panel = panels.panelsById[id];
    return panel !== undefined && isBrowserPanel(panel) && panel.location !== "trash";
  };
  const inActiveWorktree = (id: string): boolean =>
    ctx.activeWorktreeId === undefined ||
    panels.panelsById[id]?.worktreeId === ctx.activeWorktreeId;
  const inWorktree = (id: string): boolean => isLivePreview(id) && inActiveWorktree(id);
  // Nested dispatches keep the caller's source, so an agent's call isn't
  // recorded as the user's last action.
  const source = ctx.dispatchSource ?? "user";
  if (requestedPanelId !== undefined && isLiveBrowser(requestedPanelId)) {
    return toggleBrowserTool(tool, requestedPanelId, ctx, source);
  }
  if (requestedPanelId !== undefined && !isLivePreview(requestedPanelId)) {
    throw new Error(
      options.browserPanels === true
        ? "That panel is not an open dev preview or browser"
        : "That panel is not an open dev preview"
    );
  }
  // The dock's own rule for a focused browser: a global one in the dock is
  // visible in every worktree, so it is the one in front of the user.
  const focusedBrowser = focusedId ? panels.panelsById[focusedId] : undefined;
  if (
    requestedPanelId === undefined &&
    focusedId &&
    focusedBrowser &&
    isLiveBrowser(focusedId) &&
    (ctx.activeWorktreeId === undefined ||
      panelMatchesWorktreeScope(
        focusedBrowser.worktreeId,
        ctx.activeWorktreeId,
        focusedBrowser.location === "dock" ? "dock" : "grid"
      ))
  ) {
    return toggleBrowserTool(tool, focusedId, ctx, source);
  }
  let panelId =
    requestedPanelId ??
    (focusedId && inWorktree(focusedId) ? focusedId : undefined) ??
    panels.panelIds.find(inWorktree);
  const store = useDevPreviewToolStore.getState();
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
    await refuseUnlessToolApplies(tool, panelId, ctx);
    // Detection took a round trip: the preview may have been trashed in it,
    // and the session manager clears that activation. Say what the store
    // says, never what was asked.
    const live = usePanelStore.getState().panelsById[panelId];
    if (!live || live.location === "trash") {
      return { panelId, active: false };
    }
    // The pane for a preview started a moment ago may not have mounted;
    // the session should not start worktree-less because of it.
    seedDevPreviewToolContext(devPreviewToolContext(panelId, ctx));
    store.setActive(panelId, toolId);
    const activated = useDevPreviewToolStore.getState().activeByPanel[panelId] === toolId;
    if (activated) void actionService.dispatch("panel.focus", { panelId }, { source });
    return { panelId, active: activated };
  }
  // Switching a tool off is always allowed: a preview that stopped applying
  // while the tool was on must still be switchable back to plain browsing.
  if (store.activeByPanel[panelId] !== toolId) {
    await refuseUnlessToolApplies(tool, panelId, ctx);
    seedDevPreviewToolContext(devPreviewToolContext(panelId, ctx));
  }
  store.toggle(panelId, toolId);
  const active = useDevPreviewToolStore.getState().activeByPanel[panelId] === toolId;
  if (active) void actionService.dispatch("panel.focus", { panelId }, { source });
  return { panelId, active };
}

export async function runDevServerStart(args: DevServerStartArgs, ctx: ActionContext) {
  // Grid stays the default, so every caller that predates the dock
  // launcher keeps landing exactly where it did.
  const location = args?.location === "dock" ? "dock" : "grid";
  const currentProject =
    useProjectStore.getState().currentProject ??
    (await projectClient.getCurrent().catch(() => null));
  const projectId = ctx.projectId ?? currentProject?.id;

  // Scratch-owned views have no project, and the dock/palette launcher used
  // to open a dev preview there via the workspace cwd fallback (#11673).
  // The command is optional here; the pane reports a settings read failure.
  const devServerCommand = projectId
    ? await readDevServerCommand(projectId).catch(() => undefined)
    : undefined;

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
    title: "Dev server",
    cwd,
    worktreeId: ctx.activeWorktreeId,
    location,
    // Folded into the same set() that commits the panel, so the offscreen
    // container's watchdog can't close the popover in the render gap (#6590).
    ...(location === "dock" && { activateDockOnCreate: args?.activateDockOnCreate === true }),
    devCommand: devServerCommand,
  });
  return { panelId };
}

export async function runDevPreviewStop(ctx: ActionContext): Promise<void> {
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
}
