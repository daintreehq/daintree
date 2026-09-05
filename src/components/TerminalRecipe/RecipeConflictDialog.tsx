import { useEffect } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";

/**
 * Refused-write surface for in-repo recipes. Covers both reasons the main
 * process declines to overwrite `.daintree/recipes/<name>.json`:
 *
 * - `"stale"` (#9186) — the file changed externally (git pull, branch switch,
 *   stash pop) between load and save.
 * - `"forward-compat"` (#12261) — the file is unchanged, but holds fields or
 *   terminal types this build cannot represent. It was read with those parts
 *   dropped, so saving would delete them from the tracked file. `detail` names
 *   exactly what, so Overwrite is a decision rather than a guess.
 *
 * `recipeStore.updateRecipe` parks the failed update here. The user picks:
 *
 * - "Reload from disk" — discard the in-flight edit, refresh state to match disk.
 * - "Overwrite" — re-apply the edit with `force: true`, replacing disk content.
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

  const isForwardCompat = pendingConflict.reason === "forward-compat";
  const title = isForwardCompat
    ? `Recipe '${pendingConflict.recipeName}' uses unsupported content`
    : `Recipe '${pendingConflict.recipeName}' changed on disk`;

  return (
    <AppDialog isOpen={true} onClose={() => resolveConflict("cancel")} size="sm">
      <AppDialog.Header>
        <AppDialog.Title>{title}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-3">
        <AppDialog.Description>
          {isForwardCompat
            ? "This recipe's file holds content this version of Daintree can't represent — most likely written by a newer build. It was read without those parts, so saving would delete them from the file. Your unsaved edit hasn't been written."
            : "Another tool changed this recipe's file since it was loaded — usually a git pull, branch switch, or stash pop. Your unsaved edit hasn't been written. Choose how to reconcile."}
        </AppDialog.Description>
        {isForwardCompat && pendingConflict.detail && (
          <pre
            className="max-h-32 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] border border-border-default bg-surface-canvas p-2 font-mono text-xs text-text-secondary"
            data-testid="recipe-conflict-detail"
          >
            {pendingConflict.detail}
          </pre>
        )}
      </AppDialog.Body>
      <AppDialog.Footer>
        <div className="flex items-center gap-3">
          <Button
            variant="destructive"
            onClick={() => resolveConflict("overwrite")}
            data-testid="recipe-conflict-overwrite"
          >
            {isForwardCompat ? "Overwrite and discard" : "Overwrite recipe"}
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
