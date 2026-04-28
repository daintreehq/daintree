import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRecipeStore } from "@/store/recipeStore";

interface DockLaunchButtonProps {
  agentOptions: ReadonlyArray<{ type: string; label: string }>;
  onLaunchAgent: (agentId: string) => void;
  activeWorktreeId: string | null;
  cwd: string;
}

interface RecipesSectionProps {
  activeWorktreeId: string | null;
  cwd: string;
}

// Read recipes inside DropdownMenuContent so the subscription is only active
// while the menu is open. Filter via useMemo to avoid the new-array-each-render
// pitfall of subscribing to getRecipesForWorktree directly through Zustand.
function RecipesSection({ activeWorktreeId, cwd }: RecipesSectionProps) {
  const recipes = useRecipeStore((s) => s.recipes);
  const visibleRecipes = useMemo(
    () =>
      recipes.filter(
        (r) => r.worktreeId === undefined || r.worktreeId === (activeWorktreeId ?? undefined)
      ),
    [recipes, activeWorktreeId]
  );

  return (
    <>
      <DropdownMenuSeparator />
      {visibleRecipes.length === 0 ? (
        <p className="px-2.5 py-1.5 text-xs text-daintree-text/50">No recipes</p>
      ) : (
        visibleRecipes.map((recipe) => (
          <DropdownMenuItem
            key={recipe.id}
            onSelect={() =>
              void useRecipeStore
                .getState()
                .runRecipe(recipe.id, cwd, activeWorktreeId ?? undefined)
            }
          >
            {recipe.name}
          </DropdownMenuItem>
        ))
      )}
    </>
  );
}

export function DockLaunchButton({
  agentOptions,
  onLaunchAgent,
  activeWorktreeId,
  cwd,
}: DockLaunchButtonProps) {
  // Mirror AgentButton.tsx's tooltip-suppression pattern: when the dropdown
  // closes, Radix restores focus to the trigger and the tooltip would re-fire
  // on top of newly-launched panels. Hold suppression open until the next
  // genuine pointer hover (cleared via onPointerEnter).
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);

  const handleTooltipOpenChange = (open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setTooltipOpen(open);
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setTooltipOpen(false);
      }}
    >
      <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="pill"
              size="sm"
              className="px-2"
              aria-label="Launch panel"
              onPointerEnter={() => {
                isRestoringFocusRef.current = false;
              }}
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Launch panel</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={4}
        className="min-w-[12rem]"
        onCloseAutoFocus={() => {
          setTooltipOpen(false);
          isRestoringFocusRef.current = true;
        }}
      >
        {agentOptions.map(({ type, label }) => (
          <DropdownMenuItem key={type} onSelect={() => onLaunchAgent(type)}>
            New {label}
          </DropdownMenuItem>
        ))}
        <RecipesSection activeWorktreeId={activeWorktreeId} cwd={cwd} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
