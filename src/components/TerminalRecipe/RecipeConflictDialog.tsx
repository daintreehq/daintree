import { useEffect } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";

/**
 * Stale-write conflict surface for in-repo recipes (#9186). When
 * `.daintree/recipes/<name>.json` was changed externally (git pull, branch
 * switch, stash pop) between load and save, the main process refuses the
 * write with `RECIPE_STALE_CONFLICT` and `recipeStore.updateRecipe` parks
 * the failed update here. The user picks:
 *
 * - "Reload from disk" — discard the in-flight edit, refresh state to match disk.
 * - "Overwrite" — re-apply the edit with `force: true`, replacing newer disk content.
 * - Dismiss (close button / Esc) — leave the rolled-back state; user can retry later.
 *
 * Tier D1 per CLAUDE.md: local irreversible, no typed-name gate. The destructive
 * intent sits on Overwrite (in-memory edit beats disk); Reload is the safer
 * default and gets primary placement.
 */
function RecipeConflictDialogInner() {
  const pendingConflict = useRecipeConflictStore((s) => s.pendingConflict);
  const resolveConflict = useRecipeConflictStore((s) => s.resolveConflict);

  // Resolve as "cancel" on unmount so any awaited Promise in recipeStore
  // releases instead of leaking when the renderer reloads mid-conflict.
  useEffect(() => {
    return () => {
      if (useRecipeConflictStore.getState().pendingConflict) {
        useRecipeConflictStore.getState().resolveConflict("cancel");
      }
    };
  }, []);

  if (!pendingConflict) return null;

  return (
    <AppDialog isOpen={true} onClose={() => resolveConflict("cancel")} size="sm">
      <AppDialog.Header>
        <AppDialog.Title>{`Recipe '${pendingConflict.recipeName}' changed on disk`}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-3">
        <AppDialog.Description>
          Another tool changed this recipe's file since it was loaded — usually a git pull, branch
          switch, or stash pop. Your unsaved edit hasn't been written. Choose how to reconcile.
        </AppDialog.Description>
      </AppDialog.Body>
      <AppDialog.Footer>
        <div className="flex items-center gap-3">
          <Button
            variant="destructive"
            onClick={() => resolveConflict("overwrite")}
            data-testid="recipe-conflict-overwrite"
          >
            Overwrite recipe
          </Button>
          <Button
            variant="contrast"
            onClick={() => resolveConflict("reload")}
            data-testid="recipe-conflict-reload"
          >
            Reload from disk
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}

export function RecipeConflictDialog() {
  // Reset the boundary on each new request so a crashed inner dialog recovers
  // when the next conflict arrives (#9918).
  const requestSeq = useRecipeConflictStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="RecipeConflictDialog"
      resetKeys={[requestSeq]}
    >
      <RecipeConflictDialogInner />
    </ErrorBoundary>
  );
}
