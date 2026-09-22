import { Play, Pin, Copy, Pencil, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getRecipeTerminalSummary } from "../utils/recipeUtils";
import { getRecipeScope } from "@/utils/recipeScope";
import type { TerminalRecipe } from "@/types";

interface RecipeRunnerItemProps {
  recipe: TerminalRecipe;
  isFocused: boolean;
  mode: "grid" | "list";
  disabled?: boolean;
  id: string;
  tabIndex?: number;
  buttonRef?: React.Ref<HTMLButtonElement>;
  onFocus?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
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
  tabIndex,
  buttonRef,
  onFocus,
  onKeyDown,
  onRun,
  onEdit,
  onDuplicate,
  onPin,
  onUnpin,
  onDelete,
}: RecipeRunnerItemProps) {
  const recipeSummary = getRecipeTerminalSummary(recipe.terminals);
  const isPinned = recipe.showInEmptyState === true;
  const scopeLabel = getRecipeScope(recipe).label;

  if (mode === "grid") {
    return (
      // Hover AND keyboard focus, from one uncontrolled Tooltip. A native
      // `title` only ever opens on hover, and these cards are a roving tab
      // stop, so a keyboard user arrowing across "Migrate remaining J…" had no
      // way to tell two long recipes apart before launching one. The tooltip
      // replaces `title` rather than joining it — both would fire on hover.
      //
      // Persistent and hoverable, unlike the app default: this discloses
      // clipped content, not a transient hint, so it must not vanish after the
      // 2.5s auto-dismiss or close when the pointer moves onto it (WCAG 2.2
      // SC 1.4.13). Still uncontrolled — no `open` state, no restore ref.
      <Tooltip autoDismiss={false} disableHoverableContent={false}>
        <ContextMenu>
          {/* Tooltip OUTSIDE ContextMenu, TooltipTrigger INSIDE ContextMenuTrigger:
            both are `asChild`, so they compose down onto the one <button>. The
            native `title` below covers the pointer; this is what covers the
            KEYBOARD, since `title` never opens on focus and these cards are a
            roving tab stop — a keyboard user arrowing across "Migrate remaining
            J…" could not tell two long recipes apart before launching one.
            Uncontrolled, per the overlay-focus rule. Nothing restores focus to
            this card after a launch (a grid launch unmounts the surface), and
            the shared `tooltipFocusSuppression` covers the one case that would
            matter — focus handed back by a closing overlay — so there is no
            justification for a controlled tooltip here, which the rule names
            as a violation anyway. */}
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <button
                id={id}
                ref={buttonRef}
                role="option"
                aria-selected={isFocused}
                type="button"
                onClick={() => onRun(recipe.id)}
                onFocus={onFocus}
                onKeyDown={onKeyDown}
                disabled={disabled}
                tabIndex={disabled ? -1 : (tabIndex ?? 0)}
                className={cn(
                  // The roving aria-selected ring only paints while keyboard focus
                  // is inside the recipe group (group-focus-within) — at rest the
                  // default-focused first card must NOT glow accent, or the hero
                  // recipe reads as a focused input on every empty grid.
                  //
                  // `transition-colors` stays narrow: transform is deliberately out
                  // of the property list, so the press scale snaps instead of easing
                  // over 150ms. A disabled card never enters :active, so the scale
                  // needs no disabled: reset. `launcher-press` is what lets reduced
                  // motion suppress the scale — see the rule in `index.css`.
                  "launcher-press group flex flex-col items-start gap-1.5 p-3 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-subtle hover:bg-overlay-soft hover:border-border-default transition-colors active:scale-[0.98] active:duration-[1ms] text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-overlay-subtle disabled:hover:border-border-subtle group-focus-within/recipes:aria-selected:ring-2 group-focus-within/recipes:aria-selected:ring-daintree-accent/60",
                  recipe.shadowedBy && "opacity-60"
                )}
              >
                <div className="flex items-center gap-2 w-full">
                  <Play
                    className={cn(
                      "h-3.5 w-3.5 text-status-success transition-colors shrink-0",
                      !disabled && "group-hover:text-status-success"
                    )}
                    aria-hidden
                  />
                  <span className="flex-1 text-sm font-medium text-text-primary truncate">
                    {recipe.name}
                  </span>
                  {recipe.shadowedBy && (
                    <span className="text-2xs text-text-secondary shrink-0">
                      Overridden by Team
                    </span>
                  )}
                  {isPinned && (
                    // Neutral, not accent: pinning is membership, and the accent is
                    // the one signal that means "this is where the keyboard is".
                    // Spending it on a static badge left two greens on screen at
                    // once in the dense state, and made the brightest glyph on the
                    // card the one that does nothing. The state was also
                    // `aria-hidden`, so it existed for sighted users only.
                    <>
                      <Pin className="h-3 w-3 text-text-secondary shrink-0" aria-hidden />
                      <span className="sr-only">Pinned</span>
                    </>
                  )}
                </div>
                <span className="flex items-center gap-2 w-full pl-5.5 text-xs text-text-secondary">
                  <span className="shrink-0">{scopeLabel}</span>
                  {recipeSummary && recipeSummary !== recipe.name && (
                    <span className="truncate">{recipeSummary}</span>
                  )}
                </span>
              </button>
            </TooltipTrigger>
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
        {/* Radix wires `aria-describedby` to this content while it is open.
          The button's own text is already the accessible NAME, so a
          description that repeats the name gets announced twice; when there
          is a summary, describe with only that — the part the name lacks. */}
        <TooltipContent
          side="top"
          aria-label={recipeSummary && recipeSummary !== recipe.name ? recipeSummary : undefined}
        >
          <span className="font-medium">{recipe.name}</span>
          {recipeSummary && recipeSummary !== recipe.name && (
            <span className="ml-1 text-text-secondary">{recipeSummary}</span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          id={id}
          ref={buttonRef}
          role="option"
          aria-selected={isFocused}
          type="button"
          onClick={() => onRun(recipe.id)}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          disabled={disabled}
          tabIndex={disabled ? -1 : (tabIndex ?? 0)}
          title={
            recipeSummary && recipeSummary !== recipe.name
              ? `${recipe.name} — ${recipeSummary}`
              : recipe.name
          }
          className={cn(
            // The active option is marked the way the palettes mark theirs —
            // `overlay-raised` plus `selection-outline` — not with a second
            // accent ring. In list mode DOM focus stays in the filter input,
            // which paints its own accent ring, so an accent ring here put two
            // accent anchors in one arrow-key domain and the surface claimed
            // the keyboard was in two places. The house rule allows exactly one
            // load-bearing accent per focus region, and in a combobox that one
            // belongs to the control the user is typing into.
            //
            // Tokens lifted from `paletteRowStyles.ts`, which is the repo's one
            // definition of "the row Enter will act on" across ten-odd call
            // sites: `overlay-raised` clears only ~1.1:1 on its own, so the fill
            // cannot be the WCAG 1.4.11 indicator and `selection-outline` — the
            // same token the palette rail spends — has to carry the 3:1.
            //
            // What is NOT lifted is `PALETTE_ROW_CLASS` itself. Its rail paints
            // on `aria-selected` unconditionally, which is right for a palette
            // that only exists while focused and wrong for a band that sits on
            // the canvas all day: it would light the default-focused first row
            // at rest, the exact thing the grid comment above forbids. Hence the
            // `group-focus-within` gate stays and only the treatment is shared.
            "launcher-press group w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-subtle hover:bg-overlay-soft hover:border-border-default transition-colors active:scale-[0.98] active:duration-[1ms] text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-overlay-subtle disabled:hover:border-border-subtle group-focus-within/recipes:aria-selected:bg-overlay-raised group-focus-within/recipes:aria-selected:border-[var(--color-selection-outline)]",
            recipe.shadowedBy && "opacity-60"
          )}
        >
          <Play
            className="h-3.5 w-3.5 text-status-success transition-colors shrink-0"
            aria-hidden
          />
          <span className="flex-1 text-sm font-medium text-text-primary truncate">
            {recipe.name}
          </span>
          <span className="text-2xs text-text-secondary shrink-0">{scopeLabel}</span>
          {recipe.shadowedBy && (
            <span className="text-2xs text-text-secondary shrink-0">Overridden by Team</span>
          )}
          {recipeSummary && recipeSummary !== recipe.name && (
            <span className="text-xs text-text-secondary truncate max-w-[30%]">
              {recipeSummary}
            </span>
          )}
          {isPinned && (
            // Neutral, not accent: pinning is membership, and the accent is
            // the one signal that means "this is where the keyboard is".
            // Spending it on a static badge left two greens on screen at
            // once in the dense state, and made the brightest glyph on the
            // card the one that does nothing. The state was also
            // `aria-hidden`, so it existed for sighted users only.
            <>
              <Pin className="h-3 w-3 text-text-secondary shrink-0" aria-hidden />
              <span className="sr-only">Pinned</span>
            </>
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
