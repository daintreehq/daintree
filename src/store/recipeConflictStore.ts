import { create } from "zustand";
import type { TerminalRecipe } from "@/types";

/**
 * Deferred-promise gate for the in-repo recipe stale-write conflict surface
 * (#9186). The IPC handler refuses a write when `.daintree/recipes/{name}.json`
 * changed externally since load — it throws `RECIPE_STALE_CONFLICT`, the
 * `recipeStore.updateRecipe` catch rolls back optimistic state and routes the
 * decision here. The `RecipeConflictDialog` (mounted at the app level) reads
 * `pendingConflict`, surfaces the user's choice via `resolveConflict`.
 *
 * Mirrors `gitPushConfirmStore` / `panelLimitStore`: a second request while
 * one is pending resolves the first as `"cancel"` to release any awaiter.
 */

export type RecipeConflictResolution = "reload" | "overwrite" | "cancel";

/**
 * Why the write was refused. `"stale"` is the original case (#9186): the file
 * changed on disk since load. `"forward-compat"` is #12261: the file is
 * unchanged, but holds fields or terminal types this build cannot represent, so
 * saving would delete them. The two need different copy — one is about someone
 * else's edit, the other about this build's own blind spot — but the same
 * reload/overwrite resolution.
 */
export type RecipeConflictReason = "stale" | "forward-compat";

export interface RecipeConflictRequest {
  recipeId: string;
  recipeName: string;
  updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>;
  /** Original name when the failed save was a rename — passed back to the retry. */
  previousName?: string;
  reason: RecipeConflictReason;
  /**
   * For `"forward-compat"`, the main process's description of exactly what
   * would be deleted (one line per affected file). Shown verbatim so the user
   * can weigh Overwrite against a specific loss rather than a vague warning.
   */
  detail?: string;
}

interface PendingRecipeConflict extends RecipeConflictRequest {
  resolve: (action: RecipeConflictResolution) => void;
}

interface RecipeConflictState {
  pendingConflict: PendingRecipeConflict | null;
  /**
   * Monotonic counter bumped on every request. Used as the always-mounted host's
   * ErrorBoundary `resetKeys` signal so a crashed dialog auto-recovers when a new
   * request arrives — including the back-to-back supersede case where
   * `pendingConflict` never returns to null between requests (#9918).
   */
  requestSeq: number;
  requestConflict: (request: RecipeConflictRequest) => Promise<RecipeConflictResolution>;
  resolveConflict: (action: RecipeConflictResolution) => void;
}

export const useRecipeConflictStore = create<RecipeConflictState>()((set, get) => ({
  pendingConflict: null,
  requestSeq: 0,

  requestConflict: (request) => {
    const existing = get().pendingConflict;
    if (existing) existing.resolve("cancel");
    return new Promise<RecipeConflictResolution>((resolve) => {
      set((state) => ({
        pendingConflict: { ...request, resolve },
        requestSeq: state.requestSeq + 1,
      }));
    });
  },

  resolveConflict: (action) => {
    const pending = get().pendingConflict;
    if (pending) {
      pending.resolve(action);
      set({ pendingConflict: null });
    }
  },
}));
