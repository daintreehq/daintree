import { notify } from "@/lib/notify";
import type { RecipeSpawnResults } from "@/store/recipeStore";

export interface RecipeSpawnNotifyContext {
  recipeName?: string;
  projectId?: string;
}

// Surfaces partial or full recipe spawn failures for launch paths with no
// panel-owned banner (dock menu, recipe.run action, workflow creation). The
// RecipeRunner panel renders SpawnErrorBanner inline instead — callers that
// own a banner must not also call this, or the user sees both.
//
// Deliberately no worktreeId in the notify context: notify()'s origin-surface
// suppression drops the toast when the failing worktree is the active one —
// the common case for these launch paths — and none of them render an inline
// fallback, so the toast must always fire. projectId alone is not a surface
// and never triggers suppression.
export function notifyRecipeSpawnFailures(
  results: RecipeSpawnResults,
  { recipeName, projectId }: RecipeSpawnNotifyContext = {}
): void {
  if (results.failed.length === 0) return;

  const total = results.spawned.length + results.failed.length;
  const name = recipeName ? `'${recipeName}'` : "the recipe";
  const reasons = Array.from(new Set(results.failed.map((f) => f.error)));
  // A single shared reason (e.g. "Panel limit reached") is worth relaying;
  // mixed reasons would just be noise in a toast — the counts carry the signal.
  const reason = reasons.length === 1 ? ` ${reasons[0]!.replace(/\.$/, "")}.` : "";

  if (results.spawned.length === 0) {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Recipe launch failed",
      message: `Couldn't start any terminals from ${name}.${reason}`,
      context: { eventKind: "agent", projectId },
    });
    return;
  }

  notify({
    type: "warning",
    title: "Recipe partially launched",
    message: `${results.failed.length} of ${total} terminals from ${name} couldn't start.${reason}`,
    context: { eventKind: "agent", projectId },
  });
}
