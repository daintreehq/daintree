import { create } from "zustand";
import type {
  ProjectLayoutSeedOutcome,
  ProjectLayoutSeedStatus,
} from "@shared/types/plugin";
import { logWarn } from "@/utils/logger";

/** Recipes a seeded layout left for the user to start, in entry order. */
export interface WaitingLayoutRecipes {
  layoutId: string;
  layoutName: string;
  pluginName: string;
  recipes: readonly { id: string; name: string }[];
}

/**
 * This view's first-open layout seed (#13782). Main owns the record and moves
 * it; this mirrors it so the seed controller and its notice agree, and holds
 * the recipes a seed in this view left unstarted. Those are this view's alone:
 * the layout stays in the palette, so a view that is recreated loses nothing
 * the user cannot reach.
 */
interface ProjectLayoutSeedState {
  /**
   * Main's record for this view's project: `undefined` until read, `null` when
   * main has none — no project, or one whose first hydrate it has not seen.
   */
  status: ProjectLayoutSeedStatus | null | undefined;
  waiting: WaitingLayoutRecipes | null;
  /** Read main's record. Resolves to the status read, or `undefined` when it couldn't be read. */
  load: () => Promise<ProjectLayoutSeedStatus | null | undefined>;
  /**
   * Move the seed from `from` to `to` in main, only if it is still at `from`.
   * Resolves `true` when this call moved it; either way the status read back
   * is adopted, so a view that lost the race sees where the seed went.
   */
  advance: (
    from: ProjectLayoutSeedStatus,
    to: ProjectLayoutSeedStatus,
    outcome?: ProjectLayoutSeedOutcome
  ) => Promise<boolean>;
  setWaiting: (waiting: WaitingLayoutRecipes | null) => void;
  /** Drop one recipe from the waiting list once it has started. */
  recipeStarted: (recipeId: string) => void;
}

export const useProjectLayoutSeedStore = create<ProjectLayoutSeedState>((set, get) => ({
  status: undefined,
  waiting: null,
  load: async () => {
    const plugin = typeof window !== "undefined" ? window.electron?.plugin : undefined;
    if (typeof plugin?.getProjectLayoutSeed !== "function") return undefined;
    try {
      const record = await plugin.getProjectLayoutSeed();
      const status = record?.status ?? null;
      set({ status });
      return status;
    } catch (error) {
      logWarn("[ProjectLayoutSeed] Failed to read the project's layout seed", { error });
      return undefined;
    }
  },
  advance: async (from, to, outcome) => {
    const plugin = typeof window !== "undefined" ? window.electron?.plugin : undefined;
    if (typeof plugin?.advanceProjectLayoutSeed !== "function") return false;
    try {
      const { advanced, record } = await plugin.advanceProjectLayoutSeed(from, to, outcome);
      set({ status: record?.status ?? null });
      return advanced;
    } catch (error) {
      logWarn("[ProjectLayoutSeed] Failed to update the project's layout seed", { error });
      return false;
    }
  },
  setWaiting: (waiting) => set({ waiting }),
  recipeStarted: (recipeId) => {
    const { waiting } = get();
    if (waiting === null) return;
    const recipes = waiting.recipes.filter((recipe) => recipe.id !== recipeId);
    set({ waiting: recipes.length > 0 ? { ...waiting, recipes } : null });
  },
}));

export function _resetProjectLayoutSeedStoreForTest(): void {
  useProjectLayoutSeedStore.setState({ status: undefined, waiting: null });
}
