import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import { RECIPE_VARIABLE_EMPTY_TOKEN } from "@/components/TerminalRecipe/recipeVariableTokens";
import {
  resolveRecipeRunConfirmation,
  useRecipeRunConfirmStore,
} from "@/store/recipeRunConfirmStore";
import { getAvailableVariables } from "@/utils/recipeVariables";

const VARIABLE_DESCRIPTIONS = new Map(getAvailableVariables().map((v) => [v.name, v.description]));

/**
 * Singleton dialog for a recipe run whose prompts name variables with no value
 * where it would launch (#15022). Nothing in the recipe starts until the user
 * picks: back out, or run it with those variables left empty.
 */
export function RecipeRunConfirmDialog() {
  const current = useRecipeRunConfirmStore((state) => state.current);

  if (current === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Run recipe"
        onConfirm={() => {}}
        variant="default"
      />
    );
  }

  const { requestId } = current;
  return (
    <ConfirmDialog
      isOpen={true}
      onClose={() => resolveRecipeRunConfirmation(requestId, false)}
      title={`Run '${current.recipeName}' with empty variables?`}
      description="There's no value for these here, so the agents would start with them left blank in their prompts."
      confirmLabel="Run recipe"
      cancelLabel="Cancel"
      onConfirm={() => resolveRecipeRunConfirmation(requestId, true)}
      variant="default"
      // The run is the thing being questioned, so a reflexive Enter backs out.
      initialFocus="cancel"
      focusResetKey={requestId}
      bodyResetKey={requestId}
    >
      <ul className="space-y-1 text-xs" data-testid="recipe-run-missing-variables">
        {current.missing.map((name) => (
          <li key={name} className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("font-mono", RECIPE_VARIABLE_EMPTY_TOKEN)}>{`{{${name}}}`}</span>
            <span className="text-text-secondary">{VARIABLE_DESCRIPTIONS.get(name)}</span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
