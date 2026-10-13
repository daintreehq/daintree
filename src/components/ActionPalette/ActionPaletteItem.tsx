import { memo, useCallback, useMemo } from "react";
import { Pin, PinOff, EyeOff, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { ROW_CONTROL_CLASS, RowControlTooltip } from "@/components/ui/RowControl";
import { paletteSummary } from "@/lib/paletteSummary";
import { KbdChord } from "@/components/ui/Kbd";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { getActionDescriptionLine, getActionMatchRanges } from "@/lib/actionPaletteSearch";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";
import { ACTION_CATEGORY_COLORS, ACTION_CATEGORY_DEFAULT_COLOR } from "@/config/categoryColors";

/**
 * Palette-local chords for the row controls, which are presentational spans
 * (ARIA forbids interactive descendants of `role="option"`) and so have no
 * keyboard path of their own. Bare Alt is free: no default keybinding uses an
 * unmodified-Alt chord, and the obvious Mod+Shift mnemonics are taken —
 * Cmd/Ctrl+Shift+P opens this palette and Cmd/Ctrl+Shift+H launches the help
 * agent. `ActionPalette` handles both on the search input and preventDefaults,
 * so neither ever reaches the field as text.
 */
export const PIN_SHORTCUT = "Alt+P";
export const HIDE_SHORTCUT = "Alt+H";

export { paletteSummary };

interface ActionPaletteItemProps {
  item: ActionPaletteItemType;
  isSelected: boolean;
  onSelect: (item: ActionPaletteItemType) => void;
  index: number;
  onHoverIndex?: (index: number) => void;
  /** Whether this row is currently pinned (rendered in the Favorites section). */
  isPinned?: boolean;
  /** Optional pin/unpin callback. When omitted, the pin button is hidden. */
  onPin?: (item: ActionPaletteItemType) => boolean;
  onUnpin?: (id: string) => void;
  /**
   * Optional hide-from-recently-used callback. Hidden for pinned rows and for
   * destructive actions (which never reach the rail anyway). When omitted, the
   * hide button is hidden.
   */
  onHide?: (item: ActionPaletteItemType) => void;
  /**
   * Stable id of the footer-hint node. When provided it is announced via
   * aria-describedby alongside the optional rationale id, so screen readers
   * hear what Enter does for each option. Mirrors the QuickSwitcherItem
   * pattern.
   */
  footerHintId?: string;
  /** 1-based position among the navigable rows. See the ARIA note on the row. */
  posInSet?: number;
  /** Total navigable rows, excluding any inert section headers. */
  setSize?: number;
  /**
   * Whether to name the row's category. Off under a category section header,
   * which already says it for every row beneath it; on everywhere a row can
   * sit beside rows from other categories (Favorites, Recently used, search).
   */
  showCategory?: boolean;
  /** The query this row was ranked for, when it was. Drives match emphasis. */
  highlightQuery?: string;
}

function ActionPaletteItemInner({
  item,
  isSelected,
  onSelect,
  index,
  onHoverIndex,
  isPinned = false,
  onPin,
  onUnpin,
  onHide,
  footerHintId,
  posInSet,
  setSize,
  showCategory = true,
  highlightQuery,
}: ActionPaletteItemProps) {
  const categoryColor = ACTION_CATEGORY_COLORS[item.category] ?? ACTION_CATEGORY_DEFAULT_COLOR;

  const handleHover = useCallback(() => {
    onHoverIndex?.(index);
  }, [onHoverIndex, index]);

  const handlePinClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isPinned) onUnpin?.(item.id);
      else onPin?.(item);
    },
    [isPinned, onPin, onUnpin, item]
  );

  const handleHideClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onHide?.(item);
    },
    [onHide, item]
  );

  // A click on an unavailable row is a no-op, as Enter is (#8814): the reason
  // line already says why. The pin and hide controls stop propagation, so they
  // stay usable on an unavailable row.
  const handleSelectClick = useCallback(() => onSelect(item), [item, onSelect]);

  const isConfirmTier = item.danger === "confirm";
  // A destructive action can't be pinned (#7481), so the row doesn't offer it:
  // a control that exists only to be refused is a trap, not an affordance.
  const canShowPin = !isConfirmTier && Boolean(onPin || (isPinned && onUnpin));
  const canShowHide = Boolean(onHide) && !isPinned && !isConfirmTier;

  const hasRationale = isConfirmTier && Boolean(item.dangerRationale);
  const hasReason = !item.enabled && Boolean(item.disabledReason);

  const summary = useMemo(() => paletteSummary(item.description), [item.description]);

  // The option is named by its title alone and described by the rest, so a
  // screen reader hears "Kill terminal…" first and the category, summary and
  // consequence after it — not one run-on name built from every line of the
  // row. What stops the row is said before what the row is for.
  const idBase = `action-option-${item.id}`;
  const titleId = `${idBase}-title`;
  const categoryId = `${idBase}-category`;
  const summaryId = `${idBase}-summary`;
  const reasonId = `${idBase}-reason`;
  const rationaleId = `${idBase}-danger-rationale`;
  // HIG ellipsis (U+2026) signals "activation requires further input or
  // confirmation". Set tight against the title, as the app's own "Pick theme…"
  // titles are, and never doubled onto a title that already carries one.
  const displayTitle = isConfirmTier && !item.title.endsWith("…") ? `${item.title}…` : item.title;

  const match = useMemo(
    () =>
      highlightQuery
        ? getActionMatchRanges(highlightQuery, {
            title: item.title,
            titleLower: item.titleLower,
            description: item.description,
            descriptionLower: item.descriptionLower,
          })
        : null,
    [highlightQuery, item.title, item.titleLower, item.description, item.descriptionLower]
  );
  const descriptionLine = useMemo(
    () => getActionDescriptionLine(item.description, summary, match),
    [item.description, summary, match]
  );

  // The chip adds nothing when the title already says it ("Focus terminal 1"
  // under a "terminal" chip).
  const categoryInTitle = item.titleLower.includes(item.categoryLower);
  const showCategoryChip = showCategory && !categoryInTitle;

  const describedBy = [
    hasReason ? reasonId : undefined,
    hasRationale ? rationaleId : undefined,
    showCategoryChip ? categoryId : undefined,
    summary ? summaryId : undefined,
    footerHintId,
  ]
    .filter(Boolean)
    .join(" ");

  const ariaKeyshortcuts = useMemo(
    () => (item.shortcut ? comboToAriaKeyshortcuts(item.shortcut, isMac()) : undefined),
    [item.shortcut]
  );

  return (
    <div
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-start gap-3 px-3 rounded-[var(--radius-md)]",
        // A second line takes the two-line height.
        summary || hasReason || hasRationale ? "py-2" : "py-1.5",
        "text-text-secondary"
      )}
      id={idBase}
      role="option"
      aria-selected={isSelected}
      aria-disabled={!item.enabled}
      // The sectioned body seeds these because it interleaves inert section
      // headers among the rows: those headers are role="option" too (role=group
      // loses its label under Chromium + VoiceOver), so a computed set would
      // count them and announce "38 of 328" for the 36th real action. Stating
      // the position explicitly keeps the count over the rows only.
      aria-posinset={posInSet}
      aria-setsize={setSize}
      // Carried by the option itself rather than an inner control: ARIA forbids
      // interactive descendants inside `role="option"`, so there is no inner
      // button left to hold them.
      aria-haspopup={isConfirmTier ? "dialog" : undefined}
      aria-labelledby={titleId}
      aria-describedby={describedBy || undefined}
      // The visible chord sits in the presentational trailing cluster, so the
      // binding is exposed here instead of through the option's name.
      aria-keyshortcuts={ariaKeyshortcuts}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={handleHover}
      // Activation lives on the option now that no inner button can hold it.
      // The pin and hide controls stop propagation, so they still win over it.
      onClick={handleSelectClick}
    >
      {/* A div, not a button. `role="option"` must not contain interactive
          descendants — axe reports the nesting as `nested-interactive`
          (serious), and a negative tabindex does not exempt it. Activation
          lives on the option; its name computes from this subtree's text. */}
      <div className={cn("flex-1 min-w-0 text-left", !item.enabled && "cursor-not-allowed")}>
        {/* Title first, at the row's leading edge. The category used to hold a
            fixed 80px column ahead of it, which put a coloured pill before
            every title the eye ran down, and under a category header said the
            same word on every row. It now follows the title, and only where a
            row can sit beside rows from other categories. */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Unavailable steps the title down the ramp instead of fading the
              whole row. Opacity took the selection rail, the reason line and
              the still-working pin and hide controls down with it, to about
              2.5:1 — the reason is the one line on the row that has to be read. */}
          <span
            id={titleId}
            className={cn(
              "text-sm font-medium truncate",
              // The match band inks its run primary; on an unavailable row that
              // lit the matched words back up past the rest of the title.
              item.enabled ? "text-text-primary" : "text-text-secondary *:text-inherit"
            )}
          >
            <HighlightedText
              text={displayTitle}
              indices={match?.field === "title" ? match.ranges : undefined}
            />
          </span>
          {showCategoryChip && (
            <span
              id={categoryId}
              className={cn(
                "shrink-0 max-w-32 truncate rounded-[var(--radius-sm)] px-1.5 py-px text-3xs font-medium leading-tight",
                categoryColor
              )}
            >
              {item.category}
            </span>
          )}
        </div>
        {summary && (
          <div id={summaryId} className="text-xs leading-snug text-text-secondary truncate">
            <HighlightedText text={descriptionLine.text} indices={descriptionLine.ranges} />
          </div>
        )}
        {hasReason && (
          <div id={reasonId} className="text-xs leading-snug text-text-secondary italic truncate">
            {item.disabledReason}
          </div>
        )}
        {hasRationale && (
          <div
            id={rationaleId}
            // Two lines, not one: this is the consequence the confirmation
            // exists to state, and a single truncated line cut it mid-clause.
            // Shown on every destructive row, not only under the cursor: a row
            // that grew as the cursor landed on it shoved the rows below it, and
            // could slide a different action under a resting pointer.
            className="line-clamp-2 text-xs leading-snug text-text-secondary italic"
          >
            {item.dangerRationale}
          </div>
        )}
      </div>

      {/* Presentational, for the same reason as the row body above: these sit
          inside `role="option"`, where ARIA treats children as presentational
          and a real <button> trips `nested-interactive`. The palette's focus
          stays on the search input and drives rows via aria-activedescendant;
          Alt+P and Alt+H reach these from there. `RowControlTooltip` is the
          mouse tooltip; `data-testid` keeps them addressable. */}
      <div className="shrink-0 flex items-center gap-1.5 min-h-5" aria-hidden="true">
        {canShowHide && (
          <RowControlTooltip label="Hide from Recently used" shortcut={HIDE_SHORTCUT}>
            <span
              role="presentation"
              data-testid="action-palette-hide"
              onPointerDown={(e) => e.preventDefault()}
              onClick={handleHideClick}
              className={cn(
                ROW_CONTROL_CLASS,
                "opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100"
              )}
            >
              <EyeOff className="w-3.5 h-3.5" aria-hidden />
            </span>
          </RowControlTooltip>
        )}
        {canShowPin && (
          <RowControlTooltip
            label={isPinned ? "Unpin from Favorites" : "Pin to Favorites"}
            shortcut={PIN_SHORTCUT}
          >
            <span
              role="presentation"
              data-testid="action-palette-pin"
              data-pinned={isPinned}
              onPointerDown={(e) => e.preventDefault()}
              onClick={handlePinClick}
              className={cn(
                ROW_CONTROL_CLASS,
                !isPinned && "opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100"
              )}
            >
              {isPinned ? (
                <>
                  {/* At rest a pinned row states what it is; the struck-through
                      glyph is the action, so it appears only where the action is
                      offered. Showing PinOff at rest read as "not pinned". */}
                  {/* Filled: the outline pin is the "pin this" control on an
                      unpinned row, and the two read as the same mark. */}
                  <Pin
                    className="w-3.5 h-3.5 fill-current group-hover:hidden group-aria-selected:hidden"
                    aria-hidden
                  />
                  <PinOff
                    className="w-3.5 h-3.5 hidden group-hover:block group-aria-selected:block"
                    aria-hidden
                  />
                </>
              ) : (
                <Pin className="w-3.5 h-3.5" aria-hidden />
              )}
            </span>
          </RowControlTooltip>
        )}

        {item.shortcut && <KbdChord shortcut={item.shortcut} density="compact" />}

        {isConfirmTier && (
          <TriangleAlert
            aria-hidden="true"
            className="shrink-0 size-3.5 text-text-secondary transition-colors group-aria-selected:text-text-primary"
          />
        )}
      </div>
    </div>
  );
}

export const ActionPaletteItem = memo(ActionPaletteItemInner);
