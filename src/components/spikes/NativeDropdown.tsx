import * as React from "react";
import { cn } from "@/lib/utils";

export interface NativeMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface NativeDropdownProps {
  label: string;
  items: NativeMenuItem[];
  triggerClassName?: string;
}

/**
 * Pure roving-tabindex resolver. Returns the next active index for a key, or
 * `null` when the key isn't a navigation key. Extracted so keyboard parity can
 * be unit-tested without a real `[popover]` (JSDOM has neither popover nor the
 * top layer). Wraps at the ends and skips disabled items.
 */
export function resolveMenuIndex(
  key: string,
  current: number,
  items: NativeMenuItem[]
): number | null {
  const enabled = items
    .map((item, index) => ({ index, disabled: item.disabled }))
    .filter((entry) => !entry.disabled)
    .map((entry) => entry.index);
  if (enabled.length === 0) return null;

  const pos = enabled.indexOf(current);
  if (pos === -1) {
    // No valid current selection (unset, or pointing at a disabled item):
    // ArrowDown/Home land on the first enabled item, ArrowUp/End on the last.
    if (key === "ArrowDown" || key === "Home") return enabled[0]!;
    if (key === "ArrowUp" || key === "End") return enabled[enabled.length - 1]!;
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return enabled[(pos + 1) % enabled.length]!;
    case "ArrowUp":
      return enabled[(pos - 1 + enabled.length) % enabled.length]!;
    case "Home":
      return enabled[0]!;
    case "End":
      return enabled[enabled.length - 1]!;
    default:
      return null;
  }
}

/**
 * Spike: dropdown menu built on native `[popover="auto"]` + CSS Anchor
 * Positioning.
 *
 * Native gives us light-dismiss, top-layer stacking, trigger focus-restore,
 * and Escape via the internal CloseWatcher (no `dialogEscapeBackstop` needed —
 * an open menu inside an AppDialog closes on the first Escape, the dialog on
 * the second). What it does NOT give us is a focus trap or arrow-key
 * navigation — `role="menu"` parity is hand-rolled below (~30 lines).
 */
export function NativeDropdown({ label, items, triggerClassName }: NativeDropdownProps) {
  const id = React.useId();
  const safeId = id.replace(/[^a-zA-Z0-9]/g, "");
  const popoverId = `np-menu-${safeId}`;
  const anchorName = `--np-dd-${safeId}`;
  const menuRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = React.useState<number>(-1);

  const focusItem = React.useCallback((index: number) => {
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  }, []);

  React.useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open") return;
      const first = items.findIndex((item) => !item.disabled);
      if (first >= 0) focusItem(first);
    };
    menu.addEventListener("toggle", onToggle);
    return () => menu.removeEventListener("toggle", onToggle);
  }, [items, focusItem]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const next = resolveMenuIndex(event.key, activeIndex, items);
    if (next !== null) {
      event.preventDefault();
      focusItem(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item && !item.disabled) {
        item.onSelect();
        menuRef.current?.hidePopover();
      }
    }
    // Escape is intentionally left to the native CloseWatcher.
  };

  return (
    <>
      <button
        type="button"
        popoverTarget={popoverId}
        style={{ anchorName }}
        className={cn(
          "rounded-[var(--radius-md)] border border-border-default px-3 py-1.5 text-sm text-daintree-text hover:bg-overlay-subtle transition-colors",
          triggerClassName
        )}
      >
        {label}
      </button>
      <div
        ref={menuRef}
        id={popoverId}
        popover="auto"
        role="menu"
        aria-label={label}
        onKeyDown={handleKeyDown}
        style={{ "--np-anchor": anchorName } as React.CSSProperties}
        className={cn(
          "np-surface np-dropdown",
          "min-w-[8rem] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay py-1 text-daintree-text"
        )}
      >
        {items.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            tabIndex={index === activeIndex ? 0 : -1}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            onClick={() => {
              item.onSelect();
              menuRef.current?.hidePopover();
            }}
            className={cn(
              "block w-full px-3 py-1.5 text-left text-sm transition-colors",
              "hover:bg-overlay-subtle focus:bg-overlay-subtle outline-none",
              "disabled:opacity-50 disabled:pointer-events-none"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
