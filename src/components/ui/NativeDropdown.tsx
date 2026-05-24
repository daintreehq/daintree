import * as React from "react";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

type NativeDropdownItem = {
  id: string;
  label: React.ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
};

type NativeDropdownProps = {
  items: NativeDropdownItem[];
  side?: Side;
  align?: Align;
  sideOffset?: number;
  triggerClassName?: string;
  contentClassName?: string;
  children: React.ReactNode;
};

const POSITION_AREA: Record<Side, Record<Align, string>> = {
  top: { start: "top span-right", center: "top", end: "top span-left" },
  bottom: { start: "bottom span-right", center: "bottom", end: "bottom span-left" },
  left: { start: "left span-bottom", center: "left", end: "left span-top" },
  right: { start: "right span-bottom", center: "right", end: "right span-top" },
};

const TRANSFORM_ORIGIN: Record<Side, string> = {
  top: "center bottom",
  bottom: "center top",
  left: "right center",
  right: "left center",
};

function sanitizeAnchorId(id: string): string {
  return `--np-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function NativeDropdown({
  items,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  triggerClassName,
  contentClassName,
  children,
}: NativeDropdownProps) {
  const reactId = React.useId();
  const anchorName = sanitizeAnchorId(reactId);
  const popoverId = `np-dd-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);

  React.useEffect(() => {
    const node = popoverRef.current;
    if (!node) return;
    // HTMLElementEventMap types "toggle" as ToggleEvent — no cast needed.
    const handleToggle = (event: ToggleEvent) => {
      setIsOpen(event.newState === "open");
    };
    node.addEventListener("toggle", handleToggle);
    return () => node.removeEventListener("toggle", handleToggle);
  }, []);

  const handleSelect = React.useCallback((item: NativeDropdownItem) => {
    if (item.disabled) return;
    item.onSelect?.();
    popoverRef.current?.hidePopover();
  }, []);

  const triggerStyle: React.CSSProperties = { anchorName };

  // csstype's Properties type rejects `--*` keys in object literals — the
  // cast is the documented codebase pattern (see ContentPanel.tsx,
  // SortableTabButton.tsx, DemoOverlay.tsx).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const popoverStyle = {
    "--np-anchor": anchorName,
    "--np-position-area": POSITION_AREA[side][align],
    "--np-transform-origin": TRANSFORM_ORIGIN[side],
    "--np-side-offset": `${sideOffset}px`,
  } as React.CSSProperties;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={popoverId}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        style={triggerStyle}
        className={triggerClassName}
      >
        {children}
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        popover="auto"
        role="menu"
        style={popoverStyle}
        className={cn(
          "native-popover-spike native-popover-spike-dropdown surface-overlay shadow-overlay",
          contentClassName
        )}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            aria-disabled={item.disabled ? "true" : undefined}
            tabIndex={item.disabled ? -1 : 0}
            onClick={() => handleSelect(item)}
            className="native-popover-spike-dropdown-item"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
