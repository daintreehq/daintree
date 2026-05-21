import { useState, useEffect, useRef, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { GitBranch, Github, ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface ForgeProviderOption {
  id: string;
  name: string;
  pluginId: string;
}

type ProviderIcon = ComponentType<{ size?: number; className?: string }>;

function getProviderIcon(id: string): ProviderIcon {
  return id === "github" ? Github : GitBranch;
}

interface ForgeProviderSelectorDropdownProps {
  providerOptions: ForgeProviderOption[];
  activeSubtab: string;
  onSubtabChange: (id: string) => void;
}

type DropdownItem =
  | { kind: "general"; id: "general" }
  | { kind: "provider"; id: string; provider: ForgeProviderOption };

const GENERAL_ID = "general";

export function ForgeProviderSelectorDropdown({
  providerOptions,
  activeSubtab,
  onSubtabChange,
}: ForgeProviderSelectorDropdownProps) {
  const [open, setOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeItemRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const items: DropdownItem[] = (() => {
    const q = filterQuery.trim().toLowerCase();
    const generalItem: DropdownItem = { kind: "general", id: GENERAL_ID };
    const providerItems: DropdownItem[] = providerOptions
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((p) => ({ kind: "provider" as const, id: p.id, provider: p }));
    return [generalItem, ...providerItems];
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

  const handleSelect = (id: string) => {
    onSubtabChange(id);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
          handleSelect(items[activeIndex]!.id);
        }
        break;
    }
  };

  const selectedProvider =
    activeSubtab !== GENERAL_ID ? providerOptions.find((p) => p.id === activeSubtab) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          data-testid="forge-provider-selector-trigger"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 text-sm rounded-[var(--radius-md)]",
            "border border-daintree-border bg-daintree-bg text-daintree-text",
            "hover:border-border-strong transition-colors",
            "focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50"
          )}
        >
          {selectedProvider ? (
            (() => {
              const Icon = getProviderIcon(selectedProvider.id);
              return (
                <>
                  <Icon size={16} className="text-daintree-text/60" />
                  <span className="flex-1 text-left truncate">{selectedProvider.name}</span>
                </>
              );
            })()
          ) : (
            <>
              <GitBranch size={16} className="text-daintree-text/60" />
              <span className="flex-1 text-left truncate">General</span>
            </>
          )}
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-daintree-text/40 transition-transform",
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
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-daintree-border">
          <Search size={14} className="shrink-0 text-daintree-text/40" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            autoFocus
            placeholder="Filter providers…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-label="Filter providers"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls="forge-provider-selector-list"
            aria-activedescendant={
              items[activeIndex]
                ? `forge-provider-selector-item-${items[activeIndex].id}`
                : undefined
            }
            className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-daintree-text/40 focus:outline-hidden"
          />
        </div>
        <div
          role="listbox"
          id="forge-provider-selector-list"
          aria-label="Forge providers"
          className="overflow-y-auto max-h-60 p-1"
        >
          {items.map((item, index) => {
            const isActive = index === activeIndex;
            const isSelected =
              item.kind === "general" ? activeSubtab === GENERAL_ID : activeSubtab === item.id;

            return (
              <div
                key={item.id}
                ref={isActive ? activeItemRef : undefined}
                id={`forge-provider-selector-item-${item.id}`}
                role="option"
                aria-selected={isSelected}
                data-highlighted={isActive || undefined}
                onClick={() => handleSelect(item.id)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm",
                  isActive && "bg-overlay-selected",
                  isSelected && "text-daintree-text font-medium",
                  !isActive && !isSelected && "text-daintree-text"
                )}
              >
                {item.kind === "general" ? (
                  <>
                    <GitBranch size={16} className="shrink-0 text-daintree-text/60" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">General</div>
                      <div className="text-xs text-daintree-text/40 truncate">
                        Global forge settings
                      </div>
                    </div>
                  </>
                ) : (
                  (() => {
                    const Icon = getProviderIcon(item.provider.id);
                    return (
                      <>
                        <Icon size={16} className="shrink-0 text-daintree-text/60" />
                        <span className="flex-1 min-w-0 truncate">{item.provider.name}</span>
                      </>
                    );
                  })()
                )}
              </div>
            );
          })}
          {items.length === 1 && filterQuery && (
            <div className="px-2 py-3 text-xs text-daintree-text/40 text-center">
              No providers match "{filterQuery}"
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
