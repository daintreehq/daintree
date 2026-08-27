import { Info, RotateCcw, XCircle } from "lucide-react";
import { useRecipeRunner, type SpawnFailureSummary } from "./useRecipeRunner";
import { RecipeRunnerGrid } from "./RecipeRunnerGrid";
import { RecipeRunnerList } from "./RecipeRunnerList";
import { RecipeRunnerEmpty } from "./RecipeRunnerEmpty";
import { InlineStatusBanner } from "../InlineStatusBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface RecipeRunnerProps {
  activeWorktreeId: string | null | undefined;
  defaultCwd: string | undefined;
}

const MAX_FAILURE_NAMES = 2;

function formatFailureTitle(summary: SpawnFailureSummary): string {
  const failedCount = summary.failures.length;
  const startedCount = summary.totalCount - failedCount;
  const names = summary.failures.slice(0, MAX_FAILURE_NAMES).map((f) => f.displayName);
  const extra = failedCount - names.length;
  const namesPart = extra > 0 ? `${names.join(", ")}, +${extra} more` : names.join(", ");
  return `Started ${startedCount} of ${summary.totalCount} terminals. ${failedCount} failed: ${namesPart}.`;
}

function formatUnresolvedVarsTitle(vars: string[]): string {
  const list = vars.join(", ");
  if (vars.length === 1) {
    return `Missing context for {{${list}}}`;
  }
  const items = vars.map((v) => `{{${v}}}`).join(", ");
  return `Missing context for ${items}`;
}

export function RecipeRunner({ activeWorktreeId, defaultCwd }: RecipeRunnerProps) {
  const runner = useRecipeRunner({ activeWorktreeId, defaultCwd });

  // Rendered alongside both the empty and populated states so a pending delete
  // confirmation is never orphaned if the recipe list empties while open.
  const deleteDialog = (
    <ConfirmDialog
      isOpen={runner.pendingDeleteId !== null}
      title={`Delete '${runner.recipes.find((r) => r.id === runner.pendingDeleteId)?.name ?? "recipe"}'?`}
      description={
        runner.deleteError
          ? `Error: ${runner.deleteError}`
          : "Deletes this recipe — the terminals it launches and their settings. Committed in-repo recipes in .daintree/recipes/ can be restored from git; recipes stored only on this machine can't be recovered."
      }
      confirmLabel={runner.deleteError ? "Retry delete" : "Delete recipe"}
      variant="destructive"
      onConfirm={runner.confirmDelete}
      onClose={runner.cancelDelete}
    />
  );

  if (runner.recipes.length === 0) {
    return (
      <>
        <RecipeRunnerEmpty
          onCreate={runner.handleCreate}
          suggestions={runner.suggestions}
          onRunSuggestion={runner.handleRunSuggestion}
          disabled={!defaultCwd}
        />
        {deleteDialog}
      </>
    );
  }

  const flatRecipes = runner.getFlatRecipes();

  return (
    <div className="w-full">
      {runner.spawnFailureSummary && (
        <div className="mb-3" data-testid="recipe-spawn-failure-banner">
          <InlineStatusBanner
            icon={XCircle}
            title={formatFailureTitle(runner.spawnFailureSummary)}
            description={runner.spawnFailureSummary.failures[0]?.error}
            severity="error"
            action={{
              id: "retry-failed",
              label: "Retry failed",
              icon: RotateCcw,
              variant: "primary",
              onClick: runner.handleRetryFailed,
              title: "Retry the terminals that failed to start",
              ariaLabel: "Retry failed terminals",
              loading: runner.isRetryingFailed,
            }}
            onClose={runner.dismissSpawnFailures}
          />
        </div>
      )}
      {runner.unresolvedVars.length > 0 && (
        <div className="mb-3" data-testid="recipe-unresolved-vars-banner">
          <InlineStatusBanner
            icon={Info}
            title={formatUnresolvedVarsTitle(runner.unresolvedVars)}
            description="These variables stayed empty in the launched commands."
            severity="warning"
            role="status"
            actions={[]}
            onClose={runner.dismissUnresolvedVars}
          />
        </div>
      )}
      {runner.showSearch ? (
        <RecipeRunnerList
          sections={runner.sections}
          searchQuery={runner.searchQuery}
          searchResults={runner.searchResults}
          focusedIndex={runner.focusedIndex}
          focusedItemId={runner.focusedItemId}
          showSearch={runner.showSearch}
          disabled={!defaultCwd}
          onSearchChange={runner.setSearchQuery}
          onKeyDown={runner.handleKeyDown}
          onRun={runner.handleRun}
          onEdit={runner.handleEdit}
          onDuplicate={runner.handleDuplicate}
          onPin={runner.handlePin}
          onUnpin={runner.handleUnpin}
          onDelete={runner.handleDelete}
          onCreate={runner.handleCreate}
        />
      ) : (
        <RecipeRunnerGrid
          recipes={flatRecipes}
          focusedIndex={runner.focusedIndex}
          disabled={!defaultCwd}
          onRun={runner.handleRun}
          onEdit={runner.handleEdit}
          onDuplicate={runner.handleDuplicate}
          onPin={runner.handlePin}
          onUnpin={runner.handleUnpin}
          onDelete={runner.handleDelete}
          onCreate={runner.handleCreate}
          setFocusedIndex={runner.setFocusedIndex}
        />
      )}
      {deleteDialog}
    </div>
  );
}
