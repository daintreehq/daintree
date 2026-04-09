import { useRef, useMemo, useState, type ReactNode } from "react";
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
}: ThemeSelectorProps<T>) {
  const [query, setQuery] = useState("");
  const getNameRef = useRef(getName);
  getNameRef.current = getName;

  const filteredGroups = useMemo(() => {
    if (!groups) return null;
    const lq = query.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        items: lq
          ? g.items.filter((item) => getNameRef.current(item).toLowerCase().includes(lq))
          : g.items,
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const filteredItems = useMemo(() => {
    if (groups) return null;
    const all = items ?? [];
    if (!query) return all;
    const lq = query.toLowerCase();
    return all.filter((item) => getNameRef.current(item).toLowerCase().includes(lq));
  }, [items, groups, query]);

  const isEmpty = filteredGroups ? filteredGroups.length === 0 : (filteredItems?.length ?? 0) === 0;

  const colsClass = columns === 3 ? "grid-cols-3" : "grid-cols-2";

  const renderCard = (item: T) => (
    <button
      key={item.id}
      role="option"
      aria-selected={item.id === selectedId}
      onClick={(e) => onSelect(item.id, { x: e.clientX, y: e.clientY })}
      className={cn(
        "flex flex-col gap-1.5 p-2 rounded-[var(--radius-md)] border transition-colors text-left",
        item.id === selectedId
          ? "border-canopy-accent bg-canopy-accent/10"
          : "border-canopy-border bg-canopy-bg hover:border-canopy-text/30"
      )}
    >
      {renderPreview(item)}
      {renderMeta ? (
        renderMeta(item)
      ) : (
        <span className="text-xs text-canopy-text truncate">{getName(item)}</span>
      )}
    </button>
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div className="sticky top-0 z-20 bg-canopy-bg py-1">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-canopy-text/40" />
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
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-[var(--radius-md)] border border-border-strong bg-canopy-bg text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent"
          />
        </div>
      </div>

      {isEmpty ? (
        <p className="text-xs text-canopy-text/50 text-center py-4">No themes match your search.</p>
      ) : filteredGroups ? (
        <div role="listbox" id={id} aria-label="Theme list" className="space-y-2">
          {filteredGroups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/40 select-none px-1 mb-1">
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
    </div>
  );
}
