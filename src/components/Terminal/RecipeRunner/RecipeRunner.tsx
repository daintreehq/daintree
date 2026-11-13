import { useRef } from "react";
import { Plus, RefreshCw, XCircle } from "lucide-react";
import { useRecipeRunner, type SpawnFailureSummary } from "./useRecipeRunner";
import { RecipeRunnerGrid } from "./RecipeRunnerGrid";
import { RecipeRunnerList } from "./RecipeRunnerList";
import { RecipeRunnerEmpty } from "./RecipeRunnerEmpty";
import { InlineStatusBanner } from "../InlineStatusBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { getRecipeScope } from "@/utils/recipeScope";

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

function recipeOptionId(recipeId: string): string {
  return `recipe-option-${recipeId}`;
}

export function RecipeRunner({ activeWorktreeId, defaultCwd }: RecipeRunnerProps) {
  const runner = useRecipeRunner({ activeWorktreeId, defaultCwd });
  const createButtonRef = useRef<HTMLButtonElement>(null);
  // The cards after the one being deleted, then those before it nearest first:
  // the delete takes its card with it, and the context menu that asked for it
  // is gone too, so focus goes to the card that slides into its place.
  const deleteSuccessorIdsRef = useRef<string[]>([]);

  const requestDelete = (recipeId: string) => {
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('#recipe-listbox [id^="recipe-option-"]'),
      (option) => option.id
    ).filter((id) => id !== "recipe-option-create");
    const index = ids.indexOf(recipeOptionId(recipeId));
    deleteSuccessorIdsRef.current =
      index === -1 ? [] : [...ids.slice(index + 1), ...ids.slice(0, index).reverse()];
    runner.handleDelete(recipeId);
  };

  // Its own card while it is still there (a cancel), else the nearest
  // survivor, else Create, which the last delete leaves as the next step.
  const deleteFocusTarget = (): HTMLElement | null => {
    const target = runner.deleteTarget;
    const candidates = [
      target ? recipeOptionId(target.id) : null,
      ...deleteSuccessorIdsRef.current,
      "recipe-option-create",
    ];
    // In search mode the rows are the filter field's options and its arrow keys
    // drive them, so focus goes to the field with the row as its active option.
    const filter = document.querySelector<HTMLElement>(
      '[role="combobox"][aria-controls="recipe-listbox"]'
    );
    for (const id of candidates) {
      const option = id ? document.getElementById(id) : null;
      if (!option || option.matches(":disabled")) continue;
      if (!filter) return option;
      const flat = runner.getFlatRecipes();
      const index =
        id === "recipe-option-create"
          ? flat.length
          : flat.findIndex((recipe) => recipeOptionId(recipe.id) === id);
      if (index !== -1) runner.setFocusedIndex(index);
      return filter;
    }
    return filter ?? createButtonRef.current;
  };

  // Second child of the returned fragment in both states, so a confirm that
  // empties the list keeps its dialog, and with it the opener and the exit.
  const deleteDialog = (
    <ConfirmDialog
      isOpen={runner.pendingDeleteId !== null}
      title={`Delete '${runner.deleteTarget?.name ?? "recipe"}'?`}
      description={
        runner.deleteError
          ? `Error: ${runner.deleteError}`
          : "Deletes this recipe — the terminals it launches and their settings. Committed in-repo recipes in .daintree/recipes/ can be restored from git; recipes stored only on this machine can't be recovered."
      }
      confirmLabel={runner.deleteError ? "Retry delete" : "Delete recipe"}
      variant="destructive"
      isBusy={runner.isDeleting}
      restoreFocusTo={deleteFocusTarget}
      preferRestoreFocusTo
      onConfirm={runner.confirmDelete}
      onClose={runner.cancelDelete}
    />
  );

  if (runner.recipes.length === 0) {
    return (
      <>
        <RecipeRunnerEmpty
          onCreate={runner.handleCreate}
          createButtonRef={createButtonRef}
          suggestions={runner.suggestions}
          onRunSuggestion={runner.handleRunSuggestion}
          disabled={!defaultCwd}
        />
        {deleteDialog}
      </>
    );
  }

  const flatRecipes = runner.getFlatRecipes();
  // A scope label earns its place only when it tells recipes apart: printed
  // under every card when they all share it, it was the whole second line
  // saying "Team" three times.
  const showScope = new Set(runner.recipes.map((recipe) => getRecipeScope(recipe).label)).size > 1;

  return (
    <>
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
                icon: RefreshCw,
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
              title={formatUnresolvedVarsTitle(runner.unresolvedVars)}
              description="Plugin variables only get values when their plugin runs the recipe, so these launched empty."
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
            showScope={showScope}
            disabled={!defaultCwd}
            onSearchChange={runner.setSearchQuery}
            onKeyDown={runner.handleKeyDown}
            onRun={runner.handleRun}
            onEdit={runner.handleEdit}
            onDuplicate={runner.handleDuplicate}
            onPin={runner.handlePin}
            onUnpin={runner.handleUnpin}
            onDelete={requestDelete}
            onCreate={runner.handleCreate}
            onManage={runner.handleManage}
          />
        ) : (
          <RecipeRunnerGrid
            recipes={flatRecipes}
            focusedIndex={runner.focusedIndex}
            showScope={showScope}
            disabled={!defaultCwd}
            onRun={runner.handleRun}
            onEdit={runner.handleEdit}
            onDuplicate={runner.handleDuplicate}
            onPin={runner.handlePin}
            onUnpin={runner.handleUnpin}
            onDelete={requestDelete}
            setFocusedIndex={runner.setFocusedIndex}
          />
        )}
        {/* The band's two housekeeping actions share one footer line under the
          cards, at one size, on the column's edges: creating at the start,
          managing at the end. They used to be two centred lines at two sizes,
          with Create inside the cards' listbox, so Tab skipped a control that
          looked separate and the band ended in a stack of loose links.

          The canvas launches; the manager is where every recipe's other
          actions live. Right-click reaches a few of them here, but a context
          menu is not a visible path, so the band names the one that is. */}
        {!runner.showSearch && (
          <div className="mt-2 flex items-center justify-between gap-2">
            {/* On the surface's rails: a transparent 1px edge and a 16px glyph
              slot put the label on the cards' text line, and Manage's end on
              the column's secondary-action edge. */}
            <Button
              ref={createButtonRef}
              variant="ghost"
              size="sm"
              onClick={runner.handleCreate}
              className="gap-2 border border-transparent contrast-more:border-text-secondary"
            >
              <span className="flex w-4 shrink-0 justify-center">
                <Plus aria-hidden />
              </span>
              Create new recipe…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={runner.handleManage}
              className="border border-transparent contrast-more:border-text-secondary"
            >
              Manage recipes…
            </Button>
          </div>
        )}
      </div>
      {deleteDialog}
    </>
  );
}
