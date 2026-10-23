import { useEffect } from "react";
import { isGitBackedProject } from "@shared/types";
import type { PluginLayoutConfig } from "@shared/types/plugin";
import { seedPluginLayout } from "@/services/layout/applyPluginLayout";
import { usePanelStore } from "@/store/panelStore";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import { useProjectLayoutSeedStore } from "@/store/projectLayoutSeedStore";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { logWarn } from "@/utils/logger";

/**
 * The layout a project plugin names as `surfaces.defaultLayout` in this view's
 * project. Should two project plugins each name one, the lower plugin id's
 * wins, so every view of the project picks the same.
 */
export function selectProjectDefaultLayout(
  layouts: readonly PluginLayoutConfig[]
): PluginLayoutConfig | null {
  let chosen: PluginLayoutConfig | null = null;
  for (const layout of layouts) {
    if (layout.projectDefault !== true) continue;
    if (chosen === null || layout.pluginId < chosen.pluginId) chosen = layout;
  }
  return chosen;
}

/** Whether the user has anything open in the grid or dock, in any worktree. */
function hasOpenPanels(): boolean {
  const { panelIds, panelsById } = usePanelStore.getState();
  return panelIds.some((id) => {
    const location = panelsById[id]?.location;
    return location === undefined || location === "grid" || location === "dock";
  });
}

/**
 * Open the default layout's panels and pages, and leave its recipes waiting
 * for the user. This view must already hold the seed's claim (`applying`), so
 * no other view applies it meanwhile. Settled only once every entry opened; a
 * throw or an entry left unopened fails the seed instead, for the user's
 * Retry — which reuses what this attempt did open, so nothing opens twice.
 * Recipes are never started here, on a first apply or a retry.
 */
async function applySeed(layout: PluginLayoutConfig): Promise<void> {
  const seed = useProjectLayoutSeedStore.getState;
  let failures: string[];
  let deferred: Awaited<ReturnType<typeof seedPluginLayout>>["deferred"] = [];
  try {
    ({ failures, deferred } = await seedPluginLayout(layout.id));
  } catch (error) {
    failures = [String(error)];
  }
  if (failures.length > 0) {
    logWarn("[ProjectLayoutSeed] Couldn't open the project's default layout", { failures });
    await seed().advance("applying", "failed");
    return;
  }
  const recipeIds = new Set(
    deferred.flatMap((entry) => (entry.target.type === "recipe" ? [entry.target.recipeId] : []))
  );
  const { getRecipeById } = useRecipeStore.getState();
  const recipes = [...recipeIds].map((id) => ({ id, name: getRecipeById(id)?.name ?? id }));
  seed().setWaiting(
    recipes.length > 0
      ? {
          layoutId: layout.id,
          layoutName: layout.name,
          pluginName: layout.pluginName,
          recipes,
        }
      : null
  );
  await seed().advance("applying", "settled");
}

/** The user's "Open <plugin>'s layout" on an offered seed. */
export async function openOfferedLayout(layout: PluginLayoutConfig): Promise<void> {
  const claimed = await useProjectLayoutSeedStore
    .getState()
    .advance("offered", "applying", "opened");
  if (claimed) await applySeed(layout);
}

/** The user's × on an offered seed: it is never offered again. */
export async function dismissLayoutOffer(): Promise<void> {
  await useProjectLayoutSeedStore.getState().advance("offered", "settled", "dismissed");
}

/** The user's Retry on a seed whose apply failed or was cut short. */
export async function retryLayoutSeed(layout: PluginLayoutConfig): Promise<void> {
  const claimed = await useProjectLayoutSeedStore.getState().advance("failed", "applying");
  if (claimed) await applySeed(layout);
}

/** The user's × on a failed seed: the layout stays in the command palette. */
export async function dismissFailedLayoutSeed(): Promise<void> {
  await useProjectLayoutSeedStore.getState().advance("failed", "settled", "dismissed");
}

/**
 * Seed this view's project from its plugin's default layout, once (#13782).
 *
 * Main decided at the project's first hydrate whether it was a first open
 * (`pending`). From then on this waits for the default layout to arrive —
 * which, for a project plugin, means after the user trusts it, possibly much
 * later — and applies it if the grid and dock are still empty. Anything the
 * user opens first turns the seed into an offer instead, for good: an empty
 * grid later is not a first open.
 *
 * Gated on `enabled` (hydration settled), so the panels a restore brings back
 * are counted before anything is decided. Re-evaluated whenever layouts,
 * panels or the active worktree change rather than once, because each can be
 * what the seed is waiting on.
 */
export function useProjectLayoutSeed(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const seed = useProjectLayoutSeedStore.getState;
    let disposed = false;
    let running = false;
    let again = false;

    const step = async (): Promise<void> => {
      const status = seed().status;
      const layout = selectProjectDefaultLayout(usePluginLayoutsStore.getState().layouts);
      // A view whose project main hadn't bound yet when it first asked reads
      // `null`, and a failed read leaves it unknown; a default layout arriving
      // means the view is bound now, so it is worth asking again.
      if ((status === null || status === undefined) && layout !== null) {
        if ((await seed().load()) !== "pending" || disposed) return;
      } else if (status !== "pending") {
        return;
      }

      if (hasOpenPanels()) {
        await seed().advance("pending", "offered");
        return;
      }
      if (layout === null) return;
      // A worktree-scoped panel opened before a worktree is selected would
      // belong to none and never show.
      const project = useProjectStore.getState().currentProject;
      if (
        project != null &&
        isGitBackedProject(project) &&
        useWorktreeSelectionStore.getState().activeWorktreeId === null
      ) {
        return;
      }
      // Claimed before anything opens, so an apply cut short by a crash or a
      // view teardown is seen as failed and offered for a Retry, never
      // replayed on its own.
      if (!(await seed().advance("pending", "applying", "applied")) || disposed) return;
      await applySeed(layout);
    };

    const evaluate = (): void => {
      if (disposed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      void step()
        .catch((error: unknown) => {
          logWarn("[ProjectLayoutSeed] Seed evaluation failed", { error });
        })
        .finally(() => {
          running = false;
          if (again && !disposed) {
            again = false;
            evaluate();
          }
        });
    };

    const unsubscribers = [
      usePluginLayoutsStore.subscribe((state, prev) => {
        if (state.layouts !== prev.layouts) evaluate();
      }),
      // Only while pending, so the store's busier updates cost nothing after.
      // Locations count as well as ids: a panel brought out of the background
      // is opened without a new id.
      usePanelStore.subscribe((state, prev) => {
        if (seed().status !== "pending") return;
        if (state.panelIds !== prev.panelIds || state.panelsById !== prev.panelsById) evaluate();
      }),
      useWorktreeSelectionStore.subscribe((state, prev) => {
        if (state.activeWorktreeId !== prev.activeWorktreeId) evaluate();
      }),
      // Another view's apply ends without telling this one: coming back into
      // view re-reads it, so a failure there is offered for Retry here too.
      subscribeProjectViewLifecycle((phase) => {
        const status = seed().status;
        if (phase === "revealed" && (status === "applying" || status === "failed")) {
          void seed().load();
        }
      }),
    ];

    void seed()
      .load()
      .then(() => evaluate());

    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [enabled]);
}
