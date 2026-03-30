import React from "react";
import { Play, Pin, Copy, Pencil, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getRecipeTerminalSummary } from "../utils/recipeUtils";
import type { TerminalRecipe } from "@/types";

interface RecipeRunnerItemProps {
  recipe: TerminalRecipe;
  isFocused: boolean;
  mode: "grid" | "list";
  disabled?: boolean;
  id: string;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onDelete: (id: string) => void;
}

export function RecipeRunnerItem({
  recipe,
  isFocused,
  mode,
  disabled,
  id,
  onRun,
  onEdit,
  onDuplicate,
  onPin,
  onUnpin,
  onDelete,
}: RecipeRunnerItemProps) {
  const recipeSummary = getRecipeTerminalSummary(recipe.terminals);
  const isPinned = recipe.showInEmptyState === true;

  if (mode === "grid") {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            id={id}
            role="option"
            aria-selected={isFocused}
            type="button"
            onClick={() => onRun(recipe.id)}
            disabled={disabled}
            className="group flex flex-col items-start gap-1.5 p-3 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-subtle hover:bg-overlay-soft hover:border-border-default transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent disabled:opacity-50 disabled:cursor-not-allowed aria-selected:ring-2 aria-selected:ring-canopy-accent/60"
          >
            <div className="flex items-center gap-2 w-full">
              <Play
                className="h-3.5 w-3.5 text-status-success/50 group-hover:text-status-success transition-colors shrink-0"
                aria-hidden
              />
              <span className="flex-1 text-sm font-medium text-canopy-text truncate">
                {recipe.name}
              </span>
              {isPinned && <Pin className="h-3 w-3 text-canopy-accent/60 shrink-0" aria-hidden />}
            </div>
            {recipeSummary && recipeSummary !== recipe.name && (
              <span className="text-xs text-text-muted truncate w-full pl-5.5">
                {recipeSummary}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <RecipeContextMenu
          recipe={recipe}
          isPinned={isPinned}
          onRun={onRun}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onPin={onPin}
          onUnpin={onUnpin}
          onDelete={onDelete}
        />
      </ContextMenu>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          id={id}
          role="option"
          aria-selected={isFocused}
          type="button"
          onClick={() => onRun(recipe.id)}
          disabled={disabled}
          className="group w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-subtle hover:bg-overlay-soft hover:border-border-default transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent disabled:opacity-50 disabled:cursor-not-allowed aria-selected:ring-2 aria-selected:ring-canopy-accent/60"
        >
          <Play
            className="h-3.5 w-3.5 text-status-success/50 group-hover:text-status-success transition-colors shrink-0"
            aria-hidden
          />
          <span className="flex-1 text-sm font-medium text-canopy-text truncate">
            {recipe.name}
          </span>
          {recipeSummary && recipeSummary !== recipe.name && (
            <span className="text-xs text-text-muted truncate max-w-[30%]">{recipeSummary}</span>
          )}
          {isPinned && <Pin className="h-3 w-3 text-canopy-accent/60 shrink-0" aria-hidden />}
        </button>
      </ContextMenuTrigger>
      <RecipeContextMenu
        recipe={recipe}
        isPinned={isPinned}
        onRun={onRun}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onPin={onPin}
        onUnpin={onUnpin}
        onDelete={onDelete}
      />
    </ContextMenu>
  );
}

function RecipeContextMenu({
  recipe,
  isPinned,
  onRun,
  onEdit,
  onDuplicate,
  onPin,
  onUnpin,
  onDelete,
}: {
  recipe: TerminalRecipe;
  isPinned: boolean;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={() => onRun(recipe.id)}>
        <Play className="h-3.5 w-3.5 mr-2" />
        Run
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onEdit(recipe.id)}>
        <Pencil className="h-3.5 w-3.5 mr-2" />
        Edit
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onDuplicate(recipe.id)}>
        <Copy className="h-3.5 w-3.5 mr-2" />
        Duplicate
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => (isPinned ? onUnpin : onPin)(recipe.id)}>
        <Pin className="h-3.5 w-3.5 mr-2" />
        {isPinned ? "Unpin from empty state" : "Pin to empty state"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem destructive onSelect={() => onDelete(recipe.id)}>
        <Trash2 className="h-3.5 w-3.5 mr-2" />
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
