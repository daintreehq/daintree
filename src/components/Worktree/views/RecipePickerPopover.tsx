import { useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Button } from "@/components/ui/button";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { useListboxCursor } from "@/hooks/useListboxCursor";
import { Check, ChevronsUpDown, Copy, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { FIELD_TRIGGER } from "./WorktreeFormLayout";
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
  listId: string;
}

/** One row of the list. `id` is the recipe id, or a sentinel for the two fixed rows. */
type RecipeOption =
  | { id: typeof CLONE_LAYOUT_ID; kind: "clone" }
  | { id: null; kind: "none" }
  | { id: string; kind: "recipe"; recipe: TerminalRecipe };

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
  listId,
}: RecipePickerPopoverProps) {
  const options = useMemo<RecipeOption[]>(
    () => [
      { id: CLONE_LAYOUT_ID, kind: "clone" },
      { id: null, kind: "none" },
      ...recipes.map((recipe): RecipeOption => ({ id: recipe.id, kind: "recipe", recipe })),
    ],
    [recipes]
  );

  const handleSelect = (id: string | null) => {
    onMarkTouched();
    onSelectRecipe(id);
    onOpenChange(false);
  };

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListboxCursor({
    itemCount: options.length,
    open,
    onSelect: (index) => {
      const option = options[index];
      if (option) handleSelect(option.id);
    },
    onClose: () => onOpenChange(false),
  });

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={`${listId}-trigger`}
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          className={FIELD_TRIGGER}
          disabled={disabled}
          // Focus never leaves the trigger, so the list is driven from here —
          // the APG combobox model. The rows used to be tab stops instead,
          // which made a list of recipes a list of tab stops and still left the
          // arrow keys doing nothing.
          onKeyDown={(event) => {
            if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              onOpenChange(true);
              return;
            }
            if (open) handleKeyDown(event);
          }}
        >
          <span className="flex items-center gap-2 truncate">
            {selectedRecipeId === CLONE_LAYOUT_ID ? (
              <>
                <Copy className="shrink-0 text-text-secondary" />
                <span>Clone current layout</span>
              </>
            ) : selectedRecipe ? (
              <>
                <Play className="shrink-0 text-text-secondary" />
                <span>{selectedRecipe.name}</span>
                <span className="text-xs text-text-secondary">
                  ({selectedRecipe.terminals.length} terminal
                  {selectedRecipe.terminals.length !== 1 ? "s" : ""})
                </span>
              </>
            ) : (
              <>
                <Play className="shrink-0 text-text-secondary" />
                <span className="text-text-secondary">No recipe</span>
              </>
            )}
          </span>
          <ChevronsUpDown className="text-text-secondary shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Sized off the trigger, like the branch pickers above it: this panel
        // was the odd one out at a hardcoded 400px, so opening the two fields
        // in turn stepped the surface width for no reason.
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        // Focus stays on the trigger — it is the combobox, and it is what the
        // arrow keys are bound to.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <ScrollShadow
          ref={listRef}
          id={listId}
          role="listbox"
          className="max-h-[300px]"
          scrollClassName="p-1"
        >
          {options.map((option, index) => (
            <RecipeRow
              // Keyed by kind, not by id: nothing stops a saved recipe from
              // being called `__clone_layout__`, and a bare id would then
              // collide with the sentinel row's key.
              key={option.kind === "recipe" ? `recipe:${option.id}` : option.kind}
              option={option}
              index={index}
              optionId={optionId(index)}
              isCursor={index === activeIndex}
              isSelectedValue={option.id === selectedRecipeId}
              defaultRecipeId={defaultRecipeId}
              onActivate={() => setActiveIndex(index)}
              onSelect={() => handleSelect(option.id)}
            />
          ))}
        </ScrollShadow>
      </PopoverContent>
    </Popover>
  );
}

interface RecipeRowProps {
  option: RecipeOption;
  index: number;
  optionId: string;
  isCursor: boolean;
  isSelectedValue: boolean;
  defaultRecipeId?: string;
  onActivate: () => void;
  onSelect: () => void;
}

function RecipeRow({
  option,
  index,
  optionId,
  isCursor,
  isSelectedValue,
  defaultRecipeId,
  onActivate,
  onSelect,
}: RecipeRowProps) {
  return (
    <div
      id={optionId}
      data-option-index={index}
      data-option-kind={option.kind}
      role="option"
      // The cursor, and only the cursor: `PALETTE_ROW_CLASS` keys its highlight
      // off this attribute, so the announcement and the highlight are one fact,
      // and the committed value gets a check instead of a competing background.
      aria-selected={isCursor}
      aria-current={isSelectedValue ? "true" : undefined}
      onPointerMove={onActivate}
      onClick={onSelect}
      className={cn(
        PALETTE_ROW_CLASS,
        "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer",
        option.kind === "recipe" && option.recipe.shadowedBy && "opacity-60"
      )}
    >
      {option.kind === "clone" ? (
        <span className="flex items-center gap-2">
          <Copy className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
          <span>Clone current layout</span>
        </span>
      ) : option.kind === "none" ? (
        <span className="text-text-secondary">No recipe</span>
      ) : (
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">{option.recipe.name}</span>
          <span className="text-xs text-text-secondary shrink-0">
            {getRecipeScope(option.recipe).label}
          </span>
          <span className="text-xs text-text-secondary shrink-0">
            {option.recipe.terminals.length} terminal
            {option.recipe.terminals.length !== 1 ? "s" : ""}
          </span>
          {option.recipe.shadowedBy && (
            <span className="text-xs text-text-secondary shrink-0">Overridden by Team</span>
          )}
          {option.recipe.id === defaultRecipeId && (
            <span className="text-xs text-text-secondary shrink-0">(default)</span>
          )}
        </span>
      )}
      {isSelectedValue && (
        <>
          <Check className="h-4 w-4 shrink-0 text-daintree-text" aria-hidden="true" />
          <span className="sr-only">Currently selected</span>
        </>
      )}
    </div>
  );
}
