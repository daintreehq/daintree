import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pin, PinOff, EyeOff, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";
import { ACTION_CATEGORY_COLORS, ACTION_CATEGORY_DEFAULT_COLOR } from "@/config/categoryColors";

const PIN_REJECT_DURATION_MS = 2500;

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
}: ActionPaletteItemProps) {
  const categoryColor = ACTION_CATEGORY_COLORS[item.category] ?? ACTION_CATEGORY_DEFAULT_COLOR;
  const [pinRejected, setPinRejected] = useState(false);
  const rejectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Cleanup the pin-rejection auto-dismiss timer on unmount so a row that's
    // unmounted between pin-click and the 2.5s timeout doesn't fire setState
    // on a torn-down component.
    return () => {
      if (rejectTimerRef.current !== null) {
        window.clearTimeout(rejectTimerRef.current);
        rejectTimerRef.current = null;
      }
    };
  }, []);

  const handleHover = useCallback(() => {
    onHoverIndex?.(index);
  }, [onHoverIndex, index]);

  const handlePinClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isPinned) {
        onUnpin?.(item.id);
        setPinRejected(false);
        return;
      }
      const ok = onPin?.(item) ?? false;
      if (!ok) {
        setPinRejected(true);
        if (rejectTimerRef.current !== null) {
          window.clearTimeout(rejectTimerRef.current);
        }
        rejectTimerRef.current = window.setTimeout(() => {
          setPinRejected(false);
          rejectTimerRef.current = null;
        }, PIN_REJECT_DURATION_MS);
      }
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

  const handleSelectClick = useCallback(() => {
    if (!item.enabled) {
      // Mirror the previous `disabled` behavior — disabled actions still
      // dispatch (so ActionService surfaces the disabled-reason toast), but
      // the click only fires if the user explicitly hits the row body. The
      // pin/hide buttons live in a sibling element so they remain reachable
      // even when the row is disabled.
      onSelect(item);
      return;
    }
    onSelect(item);
  }, [item, onSelect]);

  const canShowPin = Boolean(onPin || (isPinned && onUnpin));
  const canShowHide = Boolean(onHide) && !isPinned && item.danger !== "confirm";

  const isConfirmTier = item.danger === "confirm";
  const hasRationale = isConfirmTier && Boolean(item.dangerRationale);
  const rationaleId = hasRationale ? `${item.id}-danger-rationale` : undefined;
  // Rationale node is CSS-hidden on unselected rows but stays in the DOM, so we
  // only point aria-describedby at it while selected. The footer hint is always
  // visible, so it's announced for every option.
  const describedBy =
    [footerHintId, isSelected ? rationaleId : undefined].filter(Boolean).join(" ") || undefined;
  // HIG ellipsis (U+2026) signals "activation requires further input or confirmation".
  // Appended at render time; the action definition's title is never mutated.
  const displayTitle = isConfirmTier ? `${item.title} …` : item.title;

  return (
    <div
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-start gap-3 px-3 py-2 rounded-[var(--radius-md)]",
        "text-daintree-text/70",
        "hover:bg-overlay-subtle hover:text-daintree-text",
        !item.enabled && "opacity-50"
      )}
      id={`action-option-${item.id}`}
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
      aria-describedby={describedBy}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={handleHover}
      // Activation lives on the option now that no inner button can hold it.
      // The pin and hide controls stop propagation, so they still win over it.
      onClick={handleSelectClick}
    >
      {/* A div, not a button. `role="option"` must not contain interactive
          descendants — axe reports the nesting as `nested-interactive`
          (serious), and a negative tabindex does not exempt it: "using a
          negative tabindex on an element inside an interactive control does not
          prevent assistive technologies from focusing the element". Activation
          lives here; the option's name computes from this subtree's text. */}
      <div
        className={cn(
          "flex-1 min-w-0 flex items-center gap-3 text-left",
          !item.enabled && "cursor-not-allowed"
        )}
      >
        {/* Fixed-width COLUMN holding a natural-width chip. Category names run
            from "git" to "preferences", so an auto-width badge started every
            title at a different x and the list read as a ragged left edge. The
            wrapper reserves the column so titles align; the chip inside stays
            its own size, because a 3-letter category stretched to 80px reads as
            a button rather than a label. */}
        <span className="w-20 shrink-0">
          <span
            className={cn(
              // Natural width inside the fixed column, not stretched to fill it:
              // a 3-letter category in an 80px pill reads as a stretched button.
              "inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight",
              categoryColor
            )}
          >
            {item.category}
          </span>
        </span>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{displayTitle}</div>
          {item.description && (
            <div className="text-xs leading-snug text-daintree-text/50 truncate">
              {item.description}
            </div>
          )}
          {!item.enabled && item.disabledReason && (
            <div className="text-[10px] leading-snug text-daintree-text/50 italic truncate">
              {item.disabledReason}
            </div>
          )}
          {hasRationale && (
            <div
              id={rationaleId}
              className="hidden group-aria-selected:block text-xs leading-snug text-daintree-text/50 italic truncate"
            >
              {item.dangerRationale}
            </div>
          )}
          {pinRejected && (
            <div
              className="text-[10px] leading-snug text-status-error mt-0.5 truncate"
              role="status"
              aria-live="polite"
            >
              Can't pin destructive actions
            </div>
          )}
        </div>
      </div>

      {/* Presentational, for the same reason as the row body above: these sit
          inside `role="option"`, where ARIA treats children as presentational
          and a real <button> trips `nested-interactive`. They were already
          `tabIndex={-1}`, so no keyboard path is lost — the palette's focus
          stays on the search input and drives rows via aria-activedescendant.
          `title` keeps the mouse tooltip; `data-testid` keeps them addressable. */}
      <div className="shrink-0 flex items-center gap-1 pt-0.5" aria-hidden="true">
        {canShowHide && (
          <span
            role="presentation"
            data-testid="action-palette-hide"
            title="Hide from Recently used"
            onPointerDown={(e) => e.preventDefault()}
            onClick={handleHideClick}
            className={cn(
              "inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] bg-transparent border-0",
              "text-daintree-text/40 opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100",
              "hover:bg-overlay-soft hover:text-daintree-text transition-colors",
              "focus-visible:opacity-100"
            )}
          >
            <EyeOff className="w-3.5 h-3.5" aria-hidden />
          </span>
        )}
        {canShowPin && (
          <span
            role="presentation"
            data-testid="action-palette-pin"
            data-pinned={isPinned}
            title={isPinned ? "Unpin from Favorites" : "Pin to Favorites"}
            onPointerDown={(e) => e.preventDefault()}
            onClick={handlePinClick}
            className={cn(
              "inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] bg-transparent border-0",
              "transition-colors hover:bg-overlay-soft",
              isPinned
                ? "text-daintree-text/70 opacity-100"
                : "text-daintree-text/40 opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100",
              "hover:text-daintree-text focus-visible:opacity-100"
            )}
          >
            {isPinned ? (
              <PinOff className="w-3.5 h-3.5" aria-hidden />
            ) : (
              <Pin className="w-3.5 h-3.5" aria-hidden />
            )}
          </span>
        )}

        {item.keybinding && (
          <span className="text-[11px] font-mono text-daintree-text/50 transition-colors group-aria-selected:text-daintree-text/70">
            {item.keybinding}
          </span>
        )}

        {isConfirmTier && (
          <TriangleAlert
            aria-hidden="true"
            className="shrink-0 size-3 text-daintree-text/40 transition-colors group-aria-selected:text-daintree-text/50"
          />
        )}
      </div>
    </div>
  );
}

export const ActionPaletteItem = memo(ActionPaletteItemInner);
