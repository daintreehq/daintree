import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown, Copy, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalRecipe } from "@/types";
import { getRecipeScope } from "@/utils/recipeScope";
import { CLONE_LAYOUT_ID } from "../hooks/useRecipePicker";

interface RecipePickerPopoverProps {
  recipes: TerminalRecipe[];
  selectedRecipeId: string | null;
  selectedRecipe: TerminalRecipe | undefined;
  defaultRecipeId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectRecipe: (id: string | null) => void;
  onMarkTouched: () => void;
  disabled?: boolean;
  label: string;
  listId: string;
}

export function RecipePickerPopover({
  recipes,
  selectedRecipeId,
  selectedRecipe,
  defaultRecipeId,
  open,
  onOpenChange,
  onSelectRecipe,
  onMarkTouched,
  disabled,
  label,
  listId,
}: RecipePickerPopoverProps) {
  const handleSelect = (id: string | null) => {
    onMarkTouched();
    onSelectRecipe(id);
    onOpenChange(false);
  };

  return (
    <div className="space-y-2">
      <label htmlFor={`${listId}-trigger`} className="block text-sm font-medium text-daintree-text">
        {label}
      </label>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id={`${listId}-trigger`}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={listId}
            className="w-full justify-between bg-daintree-bg border-daintree-border text-daintree-text hover:bg-daintree-bg hover:text-daintree-text"
            disabled={disabled}
          >
            <span className="flex items-center gap-2 truncate">
              {selectedRecipeId === CLONE_LAYOUT_ID ? (
                <>
                  <Copy className="shrink-0 text-daintree-accent" />
                  <span>Clone current layout</span>
                </>
              ) : selectedRecipe ? (
                <>
                  <Play className="shrink-0 text-daintree-accent" />
                  <span>{selectedRecipe.name}</span>
                  <span className="text-xs text-daintree-text/50">
                    ({selectedRecipe.terminals.length} terminal
                    {selectedRecipe.terminals.length !== 1 ? "s" : ""})
                  </span>
                </>
              ) : (
                <>
                  <Play className="shrink-0 text-daintree-accent" />
                  <span className="text-daintree-text/60">Empty</span>
                </>
              )}
            </span>
            <ChevronsUpDown className="text-text-muted shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[400px] p-0"
          align="start"
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <ScrollShadow id={listId} role="listbox" className="max-h-[300px]" scrollClassName="p-1">
            <div
              role="option"
              aria-selected={selectedRecipeId === CLONE_LAYOUT_ID}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleSelect(CLONE_LAYOUT_ID);
                }
              }}
              onClick={() => handleSelect(CLONE_LAYOUT_ID)}
              className={cn(
                "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-daintree-border",
                selectedRecipeId === CLONE_LAYOUT_ID && "bg-daintree-border"
              )}
            >
              <div className="flex items-center gap-2">
                <Copy className="h-3.5 w-3.5 text-daintree-text/50" />
                <span>Clone current layout</span>
              </div>
              {selectedRecipeId === CLONE_LAYOUT_ID && (
                <Check className="h-4 w-4 shrink-0 text-daintree-text" />
              )}
            </div>
            <div
              role="option"
              aria-selected={selectedRecipeId === null}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleSelect(null);
                }
              }}
              onClick={() => handleSelect(null)}
              className={cn(
                "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-daintree-border",
                selectedRecipeId === null && "bg-daintree-border"
              )}
            >
              <span className="text-daintree-text/60">Empty</span>
              {selectedRecipeId === null && (
                <Check className="h-4 w-4 shrink-0 text-daintree-text" />
              )}
            </div>
            {recipes.map((recipe) => (
              <div
                key={recipe.id}
                role="option"
                aria-selected={recipe.id === selectedRecipeId}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleSelect(recipe.id);
                  }
                }}
                onClick={() => handleSelect(recipe.id)}
                className={cn(
                  "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-daintree-border",
                  recipe.id === selectedRecipeId && "bg-daintree-border",
                  recipe.shadowedBy && "opacity-60"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{recipe.name}</span>
                  <span className="text-xs text-daintree-text/50 shrink-0">
                    {getRecipeScope(recipe).label}
                  </span>
                  <span className="text-xs text-daintree-text/50 shrink-0">
                    {recipe.terminals.length} terminal
                    {recipe.terminals.length !== 1 ? "s" : ""}
                  </span>
                  {recipe.shadowedBy && (
                    <span className="text-xs text-daintree-text/50 shrink-0">
                      Overridden by Team
                    </span>
                  )}
                  {recipe.id === defaultRecipeId && (
                    <span className="text-xs text-daintree-text/50 shrink-0">(default)</span>
                  )}
                </div>
                {recipe.id === selectedRecipeId && (
                  <Check className="h-4 w-4 shrink-0 text-daintree-text" />
                )}
              </div>
            ))}
          </ScrollShadow>
        </PopoverContent>
      </Popover>
    </div>
  );
}
