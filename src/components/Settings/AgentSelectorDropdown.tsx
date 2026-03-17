import { useState, useEffect, useRef, useCallback, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { Settings2, ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface AgentOption {
  id: string;
  name: string;
  color: string;
  Icon: ComponentType<{ size?: number; brandColor?: string; className?: string }>;
  selected: boolean;
  dangerousEnabled: boolean;
  hasCustomFlags: boolean;
}

interface AgentSelectorDropdownProps {
  agentOptions: AgentOption[];
  activeSubtab: string;
  onSubtabChange: (id: string) => void;
}

type DropdownItem =
  | { kind: "general"; id: "general" }
  | { kind: "agent"; id: string; agent: AgentOption };

const GENERAL_ID = "general";

export function AgentSelectorDropdown({
  agentOptions,
  activeSubtab,
  onSubtabChange,
}: AgentSelectorDropdownProps) {
  const [open, setOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items: DropdownItem[] = (() => {
    const q = filterQuery.trim().toLowerCase();
    const generalItem: DropdownItem = { kind: "general", id: GENERAL_ID };
    const agentItems: DropdownItem[] = agentOptions
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .map((a) => ({ kind: "agent" as const, id: a.id, agent: a }));
    return [generalItem, ...agentItems];
  })();

  useEffect(() => {
    const q = filterQuery.trim();
    setActiveIndex(q && items.length > 1 ? 1 : 0);
  }, [filterQuery]); // eslint-disable-line react-hooks/exhaustive-deps -- items derived from filterQuery

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (!open) {
      setFilterQuery("");
    }
  }, [open]);

  const handleSelect = useCallback(
    (id: string) => {
      onSubtabChange(id);
      setOpen(false);
    },
    [onSubtabChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          if (activeIndex >= 0 && activeIndex < items.length) {
            e.preventDefault();
            handleSelect(items[activeIndex].id);
          }
          break;
      }
    },
    [items, activeIndex, handleSelect]
  );

  const selectedAgent =
    activeSubtab !== GENERAL_ID ? agentOptions.find((a) => a.id === activeSubtab) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 text-sm rounded-[var(--radius-md)]",
            "border border-canopy-border bg-canopy-bg text-canopy-text",
            "hover:border-canopy-accent/50 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-canopy-accent/50"
          )}
        >
          {selectedAgent ? (
            <>
              <selectedAgent.Icon size={16} brandColor={selectedAgent.color} />
              <span className="flex-1 text-left truncate">{selectedAgent.name}</span>
              {(!selectedAgent.selected || selectedAgent.dangerousEnabled) && (
                <span className="flex items-center gap-1">
                  {!selectedAgent.selected && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-canopy-text/30"
                      title="Not in workflow"
                    />
                  )}
                  {selectedAgent.dangerousEnabled && (
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-status-error"
                      title="Skip permissions enabled"
                    />
                  )}
                </span>
              )}
            </>
          ) : (
            <>
              <Settings2 size={16} className="text-canopy-text/60" />
              <span className="flex-1 text-left truncate">General</span>
            </>
          )}
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-canopy-text/40 transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-canopy-border">
          <Search size={14} className="shrink-0 text-canopy-text/40" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            autoFocus
            placeholder="Filter agents…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-label="Filter agents"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls="agent-selector-list"
            aria-activedescendant={
              items[activeIndex] ? `agent-selector-item-${items[activeIndex].id}` : undefined
            }
            className="flex-1 min-w-0 text-xs bg-transparent text-canopy-text placeholder:text-canopy-text/40 focus:outline-none"
          />
        </div>
        <div role="listbox" id="agent-selector-list" className="overflow-y-auto max-h-60 p-1">
          {items.map((item, index) => {
            const isActive = index === activeIndex;
            const isSelected =
              item.kind === "general" ? activeSubtab === GENERAL_ID : activeSubtab === item.id;

            return (
              <div
                key={item.id}
                ref={isActive ? activeItemRef : undefined}
                id={`agent-selector-item-${item.id}`}
                role="option"
                aria-selected={isSelected}
                data-highlighted={isActive || undefined}
                onClick={() => handleSelect(item.id)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm",
                  isActive && "bg-canopy-accent/10",
                  isSelected && "text-canopy-accent",
                  !isActive && !isSelected && "text-canopy-text"
                )}
              >
                {item.kind === "general" ? (
                  <>
                    <Settings2 size={16} className="shrink-0 text-canopy-text/60" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">General</div>
                      <div className="text-xs text-canopy-text/40 truncate">Global settings</div>
                    </div>
                  </>
                ) : (
                  <>
                    <item.agent.Icon size={16} brandColor={item.agent.color} className="shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{item.agent.name}</span>
                    {(!item.agent.selected || item.agent.dangerousEnabled) && (
                      <span className="flex items-center gap-1 shrink-0">
                        {!item.agent.selected && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-canopy-text/30"
                            title="Not in workflow"
                          />
                        )}
                        {item.agent.dangerousEnabled && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-status-error"
                            title="Skip permissions enabled"
                          />
                        )}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {items.length === 1 && filterQuery && (
            <div className="px-2 py-3 text-xs text-canopy-text/40 text-center">
              No agents match "{filterQuery}"
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
