import { useRecipeRunner } from "./useRecipeRunner";
import { RecipeRunnerGrid } from "./RecipeRunnerGrid";
import { RecipeRunnerList } from "./RecipeRunnerList";
import { RecipeRunnerEmpty } from "./RecipeRunnerEmpty";

interface RecipeRunnerProps {
  activeWorktreeId: string | null | undefined;
  defaultCwd: string | undefined;
}

export function RecipeRunner({ activeWorktreeId, defaultCwd }: RecipeRunnerProps) {
  const runner = useRecipeRunner({ activeWorktreeId, defaultCwd });

  if (runner.recipes.length === 0) {
    return <RecipeRunnerEmpty onCreate={runner.handleCreate} />;
  }

  const flatRecipes = runner.getFlatRecipes();

  return (
    <div className="w-full max-w-lg">
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
          onKeyDown={runner.handleKeyDown}
        />
      )}
    </div>
  );
}
