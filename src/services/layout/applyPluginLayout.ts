import type { ActionContext } from "@shared/types/actions";
import type { TerminalRecipe } from "@shared/types";
import type { PluginLayoutConfig, PluginLayoutEntry } from "@shared/types/plugin";
import { isPluginRecipe } from "@shared/types/project";
import { isBrowserPanel, type PanelInstance } from "@shared/types/panel";
import { getPanelKindConfig, panelKindIsProjectScoped } from "@shared/config/panelKindRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import type { MaximizeTarget } from "@/store/slices/terminalFocusSlice";
import { useLayoutUndoStore } from "@/store/layoutUndoStore";
import { useRecipeStore } from "@/store/recipeStore";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import { requestLayoutApplyConfirmation } from "@/store/layoutApplyConfirmStore";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { getGridLayoutSnapshot } from "@/components/Terminal/gridLayoutSnapshot";
import { formatRecipePreviewLines } from "@/components/TerminalRecipe/recipeConfirmPreview";
import { recipeApprovalDigest } from "@/utils/recipeApprovalDigest";
import { notify } from "@/lib/notify";
import { logWarn } from "@/utils/logger";

/** A failure `recipe.run` has already told the user about. */
class ReportedRecipeFailure extends Error {}

export type LayoutApplyResult =
  | {
      status: "applied";
      /** Every panel the layout placed, opened or reused, in entry order. */
      panelIds: string[];
      /** One reason per entry that couldn't be opened; the rest still applied. */
      failures: string[];
    }
  /** A plugin's request, held for the user's answer in the confirmation dialog. */
  | { status: "awaiting-confirmation" }
  | { status: "cancelled" };

/**
 * Find the layout a dispatch names. A plugin reaches only its own: `layoutId`
 * may be its bare manifest id or the qualified one, and either resolves inside
 * the caller's namespace alone. Ids may contain dots, so a bare id is tried
 * first and wins over a qualified reading of the same string.
 */
function resolveLayout(layoutId: string, ctx: ActionContext): PluginLayoutConfig {
  const layouts = usePluginLayoutsStore.getState().layouts;
  if (ctx.dispatchSource === "plugin") {
    const caller = ctx.callerPluginId;
    const ownWithId = (id: string) =>
      layouts.find((layout) => layout.id === id && layout.pluginId === caller);
    const own =
      caller === undefined
        ? undefined
        : (ownWithId(`${caller}.${layoutId}`) ?? ownWithId(layoutId));
    if (caller === undefined || own === undefined) {
      throw new Error(`"${layoutId}" is not one of this plugin's layouts in this project`);
    }
    return own;
  }
  const layout = layouts.find((candidate) => candidate.id === layoutId);
  if (!layout) throw new Error(`No layout "${layoutId}" in this project`);
  return layout;
}

/**
 * The recipes a layout runs, resolved the way `recipe.run` will resolve them.
 * A recipe a team recipe now shadows would run the team's terminals under the
 * plugin's name, so it is refused rather than followed.
 */
function resolveLayoutRecipes(layout: PluginLayoutConfig): TerminalRecipe[] {
  const recipes: TerminalRecipe[] = [];
  for (const entry of layout.entries) {
    if (entry.target.type !== "recipe") continue;
    const { recipeId } = entry.target;
    const recipe = useRecipeStore.getState().getRecipeById(recipeId);
    if (
      !recipe ||
      recipe.id !== recipeId ||
      !isPluginRecipe(recipe) ||
      recipe.origin.pluginId !== layout.pluginId
    ) {
      throw new Error(`Layout "${layout.name}" runs a recipe that isn't available: ${recipeId}`);
    }
    recipes.push(recipe);
  }
  return recipes;
}

function isPlaceable(panel: PanelInstance | undefined): panel is PanelInstance {
  return (
    panel !== undefined &&
    (panel.location === undefined || panel.location === "grid" || panel.location === "dock")
  );
}

function sameUrl(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** Open one entry, or find the panel it already has, and return the panel ids it covers. */
async function openEntry(
  layout: PluginLayoutConfig,
  entry: PluginLayoutEntry,
  worktreeId: string | undefined,
  approvedDigests: ReadonlyMap<string, string>
): Promise<string[]> {
  const state = usePanelStore.getState();
  const live = state.panelIds.map((id) => state.panelsById[id]).filter(isPlaceable);
  const { target } = entry;

  if (target.type === "panel") {
    const kind = target.panelKindId;
    // Checked against the live kind, not the manifest the layout was read
    // from: a reload while recipes start could have made it PTY-backed, and a
    // shell must never start without the confirmation having listed it.
    const config = getPanelKindConfig(kind);
    if (config?.extensionId !== layout.pluginId || config.hasPty === true) {
      throw new Error(`Panel "${kind}" isn't available`);
    }
    // Reused the way `panel.openPluginPanel` reuses: a project panel is the
    // project's wherever it sits, any other is this worktree's.
    const projectScoped = panelKindIsProjectScoped(kind);
    const panelWorktreeId = projectScoped ? undefined : worktreeId;
    const existing = live.find(
      (panel) =>
        panel.kind === kind &&
        (projectScoped || (panel.worktreeId ?? undefined) === panelWorktreeId)
    );
    if (existing) return [existing.id];
    const id = await state.addPanel(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- documented extension-panel spawn boundary, as in panel.openPluginPanel
      {
        kind,
        worktreeId: panelWorktreeId,
        location: entry.location,
        focusPolicy: "preserve",
      } as Parameters<typeof state.addPanel>[0]
    );
    if (!id) throw new Error(`Couldn't open panel "${kind}"`);
    return [id];
  }

  if (target.type === "browser") {
    const existing = live.find(
      (panel) =>
        isBrowserPanel(panel) &&
        (panel.worktreeId ?? undefined) === worktreeId &&
        sameUrl(panel.browserUrl, target.url)
    );
    if (existing) return [existing.id];
    const id = await state.addPanel({
      kind: "browser",
      browserUrl: target.url,
      worktreeId,
      location: entry.location,
      focusPolicy: "preserve",
    });
    if (!id) throw new Error(`Couldn't open ${target.url}`);
    return [id];
  }

  // What the user approved is what runs: a recipe a plugin reload changed
  // since the dialog listed it is refused rather than started.
  const recipe = useRecipeStore.getState().getRecipeById(target.recipeId);
  if (!recipe || recipeApprovalDigest(recipe.terminals) !== approvedDigests.get(target.recipeId)) {
    throw new Error(`Recipe ${target.recipeId} changed since it was approved`);
  }
  // Dispatched as the user's own run: it follows the user's click on the
  // layout or its confirmation, never a plugin's or an agent's request alone.
  const result = await actionService.dispatch(
    "recipe.run",
    {
      recipeId: target.recipeId,
      ...(worktreeId !== undefined && { worktreeId }),
      // The layout decides focus and maximize once everything has opened; a
      // recipe left to its default would exit an unlisted panel's maximize.
      focusPolicy: "preserve",
    },
    { source: "user" }
  );
  if (!result.ok) throw new ReportedRecipeFailure(result.error.message);
  const value: unknown = result.result;
  return typeof value === "object" &&
    value !== null &&
    "spawnedTerminalIds" in value &&
    Array.isArray(value.spawnedTerminalIds)
    ? value.spawnedTerminalIds.filter((id): id is string => typeof id === "string")
    : [];
}

/**
 * The maximize repair for listed panels leaving a maximized group, as
 * `placeTerminal` makes it for one panel leaving: a group that survives stays
 * maximized on a tab still in it, and one that dissolved leaves its unlisted
 * survivor maximized alone.
 */
function repairMaximizeAfterDetach(
  target: MaximizeTarget,
  members: readonly string[],
  listed: ReadonlySet<string>
): void {
  const store = usePanelStore.getState;
  if (target?.type !== "group" || !members.some((id) => listed.has(id))) return;
  const group = store().tabGroups.get(target.id);
  if (group) {
    const { maximizedId } = store();
    if (maximizedId !== null && !group.panelIds.includes(maximizedId)) {
      store().setMaximizedId(group.activeTabId);
    }
    return;
  }
  store().exitMaximize();
  const survivor = members.find(
    (id) => !listed.has(id) && store().panelsById[id]?.location === "grid"
  );
  if (survivor !== undefined) {
    const { gridCols, gridItemCount } = getGridLayoutSnapshot();
    store().toggleMaximize(survivor, gridCols, gridItemCount, store().getPanelGroup);
  }
}

/** Group, place and maximize what the entries opened. Only listed panels move. */
function arrange(placed: ReadonlyArray<{ entry: PluginLayoutEntry; ids: string[] }>): void {
  const store = usePanelStore.getState;
  for (const { entry, ids } of placed) {
    for (const id of ids) store().placeTerminal(id, entry.location);
  }

  const groups = new Map<string, string[]>();
  for (const { entry, ids } of placed) {
    if (entry.tabGroup === undefined) continue;
    const members = ids.filter((id) => store().panelsById[id]?.location === entry.location);
    groups.set(entry.tabGroup, [...(groups.get(entry.tabGroup) ?? []), ...members]);
  }
  for (const [key, ids] of groups) {
    const panels = ids.map((id) => store().panelsById[id]);
    const first = panels[0];
    if (ids.length < 2 || !first) continue;
    const worktreeId = first.worktreeId;
    if (panels.some((panel) => (panel?.worktreeId ?? undefined) !== (worktreeId ?? undefined))) {
      logWarn("[Layouts] Tab group members ended up in different worktrees", { key });
      continue;
    }
    const existing = store().getPanelGroup(first.id);
    if (
      existing &&
      existing.panelIds.length === ids.length &&
      ids.every((id) => existing.panelIds.includes(id))
    ) {
      if (existing.panelIds.some((id, index) => id !== ids[index])) {
        store().reorderPanelsInGroup(existing.id, ids);
      }
      continue;
    }
    // A listed panel leaves whatever group it was in; the unlisted tabs it
    // leaves behind stay where they are, a maximize they held included.
    const { maximizeTarget, tabGroups, focusedId } = store();
    const maximizedMembers =
      maximizeTarget?.type === "group" ? (tabGroups.get(maximizeTarget.id)?.panelIds ?? []) : [];
    for (const id of ids) store().removePanelFromGroup(id);
    repairMaximizeAfterDetach(maximizeTarget, maximizedMembers, new Set(ids));
    const location = first.location === "dock" ? "dock" : "grid";
    // A focused member stays the visible tab, so focus never lands on a hidden one.
    const activeTabId = ids.find((id) => id === focusedId) ?? first.id;
    store().createTabGroup(location, worktreeId, ids, activeTabId);
  }

  const maximized = placed.find(({ entry, ids }) => entry.maximized === true && ids.length > 0);
  const targetId = maximized?.ids[0];
  if (targetId === undefined || store().panelsById[targetId]?.location !== "grid") return;
  const { maximizeTarget, getPanelGroup } = store();
  const group = getPanelGroup(targetId);
  // A maximized group shows its active tab, so the requested panel has to be it.
  if (group && group.activeTabId !== targetId) store().setActiveTab(group.id, targetId);
  // What fills the grid has to be exactly the panel or its group: a panel
  // maximized alone and now grouped would otherwise keep hiding its new tabs.
  const wanted = group ? { type: "group", id: group.id } : { type: "panel", id: targetId };
  if (maximizeTarget?.type !== wanted.type || maximizeTarget.id !== wanted.id) {
    store().exitMaximize();
    const { gridCols, gridItemCount } = getGridLayoutSnapshot();
    store().toggleMaximize(targetId, gridCols, gridItemCount, getPanelGroup);
  }
  store().setFocused(targetId);
}

async function applyResolved(
  layoutId: string,
  approvedDigests: ReadonlyMap<string, string>
): Promise<LayoutApplyResult> {
  // Read again at apply time: a confirmation can outlast the plugin's reload,
  // and the worktree the user is looking at may have changed while it was open.
  const layout = usePluginLayoutsStore.getState().layouts.find((l) => l.id === layoutId);
  if (!layout) throw new Error("The layout is no longer available");
  const worktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? undefined;

  // One undo entry covers the whole apply. It is taken before anything opens,
  // so undo puts every moved panel back; what the layout opened stays open.
  useLayoutUndoStore.getState().pushLayoutSnapshot();

  const placed: Array<{ entry: PluginLayoutEntry; ids: string[] }> = [];
  const failures: string[] = [];
  // `recipe.run` already tells the user about its own failures; one refused
  // before it ran, such as a recipe that changed since approval, it never saw.
  const unreported: string[] = [];
  for (const entry of layout.entries) {
    try {
      placed.push({ entry, ids: await openEntry(layout, entry, worktreeId, approvedDigests) });
    } catch (error) {
      const reason = formatErrorMessage(error, "Couldn't open a layout entry");
      failures.push(reason);
      if (!(error instanceof ReportedRecipeFailure)) unreported.push(reason);
    }
  }
  arrange(placed);

  if (unreported.length > 0) {
    notify({
      type: "warning",
      priority: "high",
      title: "Layout partly applied",
      message: `${layout.name}: ${unreported.join("; ")}.`,
      context: { eventKind: "uiFeedback" },
      action: {
        label: "Undo layout",
        actionId: "layout.undo",
        onClick: () => {
          void actionService.dispatch("layout.undo", undefined, { source: "user" });
        },
      },
    });
  }
  return { status: "applied", panelIds: placed.flatMap(({ ids }) => ids), failures };
}

/**
 * Apply a plugin layout (#13780): open or reuse each listed panel, browser page
 * and recipe, then place, group and maximize them. Additive — a panel the
 * layout doesn't list is never closed or moved.
 *
 * A layout that runs a recipe first lists every terminal it starts, the way
 * the recipe confirmation does, and starts nothing until the user approves. A
 * plugin's request returns while the dialog is open, since its dispatch has a
 * deadline a person reading the dialog shouldn't race.
 */
export async function applyPluginLayout(
  layoutId: string,
  ctx: ActionContext
): Promise<LayoutApplyResult> {
  if (ctx.dispatchSource === "agent") {
    throw new Error("Layouts are applied by the user or by the plugin that declares them");
  }
  const layout = resolveLayout(layoutId, ctx);
  const recipes = resolveLayoutRecipes(layout);
  if (recipes.length === 0) return applyResolved(layout.id, new Map());

  const approvedDigests = new Map(
    recipes.map((recipe) => [recipe.id, recipeApprovalDigest(recipe.terminals)])
  );
  const approval = requestLayoutApplyConfirmation({
    layoutId: layout.id,
    layoutName: layout.name,
    pluginName: layout.pluginName,
    previewLines: recipes.flatMap((recipe, index) => [
      ...(index > 0 ? [""] : []),
      ...formatRecipePreviewLines(recipe, { spawns: true }),
    ]),
  });

  if (ctx.dispatchSource === "plugin") {
    void approval
      .then((approved) => (approved ? applyResolved(layout.id, approvedDigests) : undefined))
      .catch((error: unknown) => notifyApplyFailed(layout.name, error));
    return { status: "awaiting-confirmation" };
  }
  if (!(await approval)) return { status: "cancelled" };
  return applyResolved(layout.id, approvedDigests);
}

function notifyApplyFailed(layoutName: string, error: unknown): void {
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    priority: "high",
    title: "Layout not applied",
    message: `${layoutName}: ${formatErrorMessage(error, "The layout couldn't be applied")}.`,
    context: { eventKind: "uiFeedback" },
  });
}
