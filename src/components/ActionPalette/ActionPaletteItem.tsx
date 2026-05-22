import { memo, useCallback, useState } from "react";
import { Pin, PinOff, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";
import { ACTION_CATEGORY_COLORS, ACTION_CATEGORY_DEFAULT_COLOR } from "@/config/categoryColors";

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
}: ActionPaletteItemProps) {
  const categoryColor = ACTION_CATEGORY_COLORS[item.category] ?? ACTION_CATEGORY_DEFAULT_COLOR;
  const [pinRejected, setPinRejected] = useState(false);

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
        // Auto-clear the rejection tooltip after a brief moment so the user
        // can re-attempt without the message lingering forever.
        window.setTimeout(() => setPinRejected(false), 2500);
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

  const canShowPin = Boolean(onPin || (isPinned && onUnpin));
  const canShowHide = Boolean(onHide) && !isPinned && item.danger !== "confirm";

  return (
    <button
      id={`action-option-${item.id}`}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={handleHover}
      role="option"
      aria-selected={isSelected}
      aria-disabled={!item.enabled}
      disabled={!item.enabled}
      className={cn(
        "group relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors",
        "border border-transparent text-daintree-text/70",
        "hover:bg-overlay-subtle hover:text-daintree-text",
        "aria-selected:bg-overlay-soft aria-selected:border-overlay aria-selected:text-daintree-text",
        "aria-selected:before:absolute aria-selected:before:left-0 aria-selected:before:top-2 aria-selected:before:bottom-2",
        "aria-selected:before:w-[2px] aria-selected:before:bg-daintree-accent aria-selected:before:content-['']",
        !item.enabled && "opacity-40 cursor-not-allowed"
      )}
      onClick={() => onSelect(item)}
    >
      <span
        className={cn(
          "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
          categoryColor
        )}
      >
        {item.category}
      </span>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.title}</div>
        {item.description && (
          <div className="text-xs text-daintree-text/50 truncate">{item.description}</div>
        )}
        {!item.enabled && item.disabledReason && (
          <div className="text-[10px] text-daintree-text/40 italic truncate">
            {item.disabledReason}
          </div>
        )}
        {pinRejected && (
          <div
            className="text-[10px] text-status-error mt-0.5 truncate"
            role="status"
            aria-live="polite"
          >
            Can't pin destructive actions
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-1">
        {canShowHide && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Hide '${item.title}' from Recently used`}
            title="Hide from Recently used"
            onPointerDown={(e) => e.preventDefault()}
            onClick={handleHideClick}
            className={cn(
              "inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)]",
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
            role="button"
            tabIndex={-1}
            aria-label={isPinned ? `Unpin '${item.title}'` : `Pin '${item.title}' to Favorites`}
            aria-pressed={isPinned}
            title={isPinned ? "Unpin from Favorites" : "Pin to Favorites"}
            onPointerDown={(e) => e.preventDefault()}
            onClick={handlePinClick}
            className={cn(
              "inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)]",
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
          <span className="text-[11px] font-mono text-daintree-text/40 transition-colors group-aria-selected:text-daintree-text/60">
            {item.keybinding}
          </span>
        )}
      </div>
    </button>
  );
}

export const ActionPaletteItem = memo(ActionPaletteItemInner);
