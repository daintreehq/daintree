import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

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
}

export type ThemeSelectorProps<T extends { id: string }> =
  | (ThemeSelectorCommon<T> & { items: T[]; groups?: never })
  | (ThemeSelectorCommon<T> & { items?: never; groups: ThemeSelectorGroup<T>[] });

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
}: ThemeSelectorProps<T>) {
  const [query, setQuery] = useState("");

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

  const isEmpty = filteredGroups ? filteredGroups.length === 0 : (filteredItems?.length ?? 0) === 0;

  const colsClass = columns === 3 ? "grid-cols-3" : "grid-cols-2";

  const handlePreviewEnter = (itemId: string) => {
    if (!onPreviewItem) return;
    cancelPendingRevert();
    onPreviewItem(itemId);
  };

  const handlePreviewLeave = () => {
    if (!onPreviewItem && !onPreviewEnd) return;
    scheduleRevert();
  };

  const renderCard = (item: T) => (
    <button
      key={item.id}
      role="option"
      aria-selected={item.id === selectedId}
      onClick={(e) => onSelect(item.id, { x: e.clientX, y: e.clientY })}
      onPointerEnter={() => handlePreviewEnter(item.id)}
      onPointerLeave={handlePreviewLeave}
      onFocus={() => handlePreviewEnter(item.id)}
      onBlur={handlePreviewLeave}
      className={cn(
        "flex flex-col gap-1.5 p-2 rounded-[var(--radius-md)] border transition-colors text-left",
        "[&>*]:pointer-events-none",
        item.id === selectedId
          ? "border-border-strong bg-overlay-selected"
          : "border-daintree-border bg-daintree-bg hover:border-daintree-text/30"
      )}
    >
      {renderPreview(item)}
      {renderMeta ? (
        renderMeta(item)
      ) : (
        <span className="text-xs text-daintree-text truncate">{getName(item)}</span>
      )}
    </button>
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div className="sticky top-0 z-20 bg-daintree-bg py-1">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-daintree-text/40" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Filter themes..."
            aria-label="Filter themes"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text placeholder:text-daintree-text/40 focus:outline-none focus:border-daintree-accent"
          />
        </div>
      </div>

      {isEmpty ? (
        <p className="text-xs text-daintree-text/50 text-center py-4">
          No themes match your search.
        </p>
      ) : filteredGroups ? (
        <div role="listbox" id={id} aria-label="Theme list" className="space-y-2">
          {filteredGroups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p className="text-[10px] font-medium uppercase tracking-wider text-daintree-text/40 select-none px-1 mb-1">
                {group.label}
              </p>
              <div className={cn("grid gap-2", colsClass)}>{group.items.map(renderCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div role="listbox" id={id} aria-label="Theme list" className={cn("grid gap-2", colsClass)}>
          {filteredItems?.map(renderCard)}
        </div>
      )}

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {previewAnnouncement ?? ""}
      </div>
    </div>
  );
}
