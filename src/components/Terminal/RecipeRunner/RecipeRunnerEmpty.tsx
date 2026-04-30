import { Plus } from "lucide-react";

interface RecipeRunnerEmptyProps {
  onCreate: () => void;
}

export function RecipeRunnerEmpty({ onCreate }: RecipeRunnerEmptyProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <p className="text-xs text-text-muted">
        Recipes let you launch multi-terminal workflows with a single click
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="group flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] hover:bg-overlay-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
      >
        <Plus
          className="h-3.5 w-3.5 text-text-muted group-hover:text-daintree-text transition-colors shrink-0"
          aria-hidden
        />
        <span className="text-sm text-text-muted group-hover:text-daintree-text transition-colors">
          Create new recipe…
        </span>
      </button>
    </div>
  );
}
