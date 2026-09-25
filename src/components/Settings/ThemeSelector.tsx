import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchField } from "@/components/ui/SearchField";

interface ThemeSelectorGroup<T> {
  label: string;
  items: T[];
}

interface ThemeSelectorCommon<T extends { id: string }> {
  selectedId: string;
  onSelect: (id: string, origin?: { x: number; y: number }) => void;
  renderPreview: (item: T) => ReactNode;
  renderMeta?: (item: T) => ReactNode;
  getName: (item: T) => string;
  columns?: 2 | 3;
  className?: string;
  id?: string;
  /** Called when pointer enters or focus lands on a card. Receives the card id. */
  onPreviewItem?: (id: string) => void;
  /** Called after pointer leaves or focus blurs a card, on the next animation frame. */
  onPreviewEnd?: () => void;
  /** Text announced via a polite aria-live region as the previewed item changes. */
  previewAnnouncement?: string;
  /** Controls at the end of the filter row — a Dark/Light switch, say. */
  toolbar?: ReactNode;
  searchPlaceholder?: string;
  searchLabel?: string;
  listLabel?: string;
  emptyMessage?: string;
  /** Names the listbox from a visible label instead of `listLabel`. */
  listLabelledBy?: string;
}

export type ThemeSelectorProps<T extends { id: string }> =
  | (ThemeSelectorCommon<T> & { items: T[]; groups?: never })
  | (ThemeSelectorCommon<T> & { items?: never; groups: ThemeSelectorGroup<T>[] });

/**
 * A filterable grid of visual options: one listbox, one tab stop.
 *
 * Arrow keys walk the grid by row and column, Home/End jump to the ends, and moving
 * selects — the settings radio contract, where the keyboard and the choice travel
 * together. Each option is named by its label alone; the preview inside it is
 * presentation, so a screen reader hears "Dracula, selected" rather than five lines
 * of sample terminal output first.
 */
export function ThemeSelector<T extends { id: string }>({
  items,
  groups,
  selectedId,
  onSelect,
  renderPreview,
  renderMeta,
  getName,
  columns = 2,
  className,
  id,
  onPreviewItem,
  onPreviewEnd,
  previewAnnouncement,
  toolbar,
  searchPlaceholder = "Filter themes...",
  searchLabel = "Filter themes",
  listLabel = "Theme list",
  emptyMessage = "No themes match your search.",
  listLabelledBy,
}: ThemeSelectorProps<T>) {
  const [query, setQuery] = useState("");
  // Where the keyboard is inside the grid. Null until an option takes focus, so Tab
  // enters on the selection rather than on wherever focus last sat.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());

  // Single rAF handle shared across all cards so rapid pointer moves between
  // cards cancel any pending revert before the next preview fires.
  const revertRafRef = useRef<number | null>(null);
  const onPreviewEndRef = useRef(onPreviewEnd);
  useEffect(() => {
    onPreviewEndRef.current = onPreviewEnd;
  }, [onPreviewEnd]);

  const cancelPendingRevert = () => {
    if (revertRafRef.current !== null) {
      cancelAnimationFrame(revertRafRef.current);
      revertRafRef.current = null;
    }
  };

  const scheduleRevert = () => {
    cancelPendingRevert();
    revertRafRef.current = requestAnimationFrame(() => {
      revertRafRef.current = null;
      onPreviewEndRef.current?.();
    });
  };

  useEffect(
    () => () => {
      if (revertRafRef.current !== null) {
        cancelAnimationFrame(revertRafRef.current);
        revertRafRef.current = null;
      }
    },
    []
  );

  const filteredGroups = useMemo(() => {
    if (!groups) return null;
    const lq = query.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        items: lq ? g.items.filter((item) => getName(item).toLowerCase().includes(lq)) : g.items,
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query, getName]);

  const filteredItems = useMemo(() => {
    if (groups) return null;
    const all = items ?? [];
    if (!query) return all;
    const lq = query.toLowerCase();
    return all.filter((item) => getName(item).toLowerCase().includes(lq));
  }, [items, groups, query, getName]);

  const flatItems = useMemo(
    () => (filteredGroups ? filteredGroups.flatMap((g) => g.items) : (filteredItems ?? [])),
    [filteredGroups, filteredItems]
  );

  const isEmpty = flatItems.length === 0;
  const colsClass = columns === 3 ? "grid-cols-3" : "grid-cols-2";

  const tabStopId =
    (focusedId && flatItems.some((item) => item.id === focusedId) ? focusedId : null) ??
    (flatItems.some((item) => item.id === selectedId) ? selectedId : flatItems[0]?.id);

  const handlePreviewEnter = (itemId: string) => {
    if (!onPreviewItem) return;
    cancelPendingRevert();
    onPreviewItem(itemId);
  };

  const handlePreviewLeave = () => {
    if (!onPreviewItem && !onPreviewEnd) return;
    scheduleRevert();
  };

  const moveTo = (index: number) => {
    const item = flatItems[index];
    if (!item) return;
    setFocusedId(item.id);
    optionRefs.current.get(item.id)?.focus();
    if (item.id !== selectedId) onSelect(item.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (flatItems.length === 0) return;
    // Step from the option that has the keyboard, not from the selection: after a
    // rejected save they differ, and stepping from the selection would retry it.
    const from = flatItems.findIndex((item) => item.id === (focusedId ?? selectedId));
    const current = from === -1 ? 0 : from;
    const last = flatItems.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(current + 1, last);
        break;
      case "ArrowLeft":
        next = Math.max(current - 1, 0);
        break;
      case "ArrowDown":
        // Straight down or not at all: clamping to the last option would slide the
        // selection sideways off the bottom row.
        next = current + columns <= last ? current + columns : current;
        break;
      case "ArrowUp":
        next = current - columns >= 0 ? current - columns : current;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(next);
  };

  const renderCard = (item: T) => {
    const isSelected = item.id === selectedId;
    return (
      <button
        key={item.id}
        ref={(el) => {
          if (el) optionRefs.current.set(item.id, el);
          else optionRefs.current.delete(item.id);
        }}
        type="button"
        role="option"
        aria-selected={isSelected}
        aria-label={getName(item)}
        tabIndex={item.id === tabStopId ? 0 : -1}
        onClick={(e) => {
          setFocusedId(item.id);
          onSelect(item.id, { x: e.clientX, y: e.clientY });
        }}
        onPointerEnter={() => handlePreviewEnter(item.id)}
        onPointerLeave={handlePreviewLeave}
        onFocus={() => {
          setFocusedId(item.id);
          handlePreviewEnter(item.id);
        }}
        onBlur={handlePreviewLeave}
        className={cn(
          "group/option flex flex-col gap-1.5 p-1.5 rounded-[var(--radius-md)] border text-left transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
          "[&>*]:pointer-events-none",
          // The selected option carries a check and a text-secondary frame: the frame
          // clears 3:1 against the card on every built-in theme, where border-strong
          // (an ink at 14-22% alpha) does not. forced-colors keeps it via the outline.
          isSelected
            ? "border-text-secondary bg-overlay-selected forced-colors:outline forced-colors:outline-2"
            : "border-transparent hover:bg-overlay-soft"
        )}
      >
        <div aria-hidden="true">{renderPreview(item)}</div>
        <div className="flex items-center gap-1.5 px-0.5 min-w-0">
          {renderMeta ? (
            renderMeta(item)
          ) : (
            <span className="text-xs text-text-primary truncate flex-1">{getName(item)}</span>
          )}
          {isSelected && (
            <Check className="w-3.5 h-3.5 shrink-0 text-text-primary" aria-hidden="true" />
          )}
        </div>
      </button>
    );
  };

  const listboxProps = {
    role: "listbox" as const,
    id,
    "aria-label": listLabelledBy ? undefined : listLabel,
    "aria-labelledby": listLabelledBy,
    onKeyDown: handleKeyDown,
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedId(null);
    },
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        <SearchField
          size="compact"
          fieldClassName="flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={searchPlaceholder}
          aria-label={searchLabel}
        />
        {toolbar}
      </div>

      {isEmpty ? (
        <p className="text-xs text-text-secondary py-6 text-center">{emptyMessage}</p>
      ) : filteredGroups ? (
        <div {...listboxProps} className="space-y-3">
          {filteredGroups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p className="text-xs font-medium text-text-secondary select-none px-0.5 mb-1.5">
                {group.label}
              </p>
              <div className={cn("grid gap-2", colsClass)}>{group.items.map(renderCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div {...listboxProps} className={cn("grid gap-2", colsClass)}>
          {flatItems.map(renderCard)}
        </div>
      )}

      {/* Always mounted, so a filter that empties the list is heard as well as seen. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {isEmpty ? emptyMessage : (previewAnnouncement ?? "")}
      </div>
    </div>
  );
}
