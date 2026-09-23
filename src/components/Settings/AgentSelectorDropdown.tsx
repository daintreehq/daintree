import { useState, useEffect, useRef, type ComponentType, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Settings2, ChevronDown, Search, ShieldOff, Check } from "lucide-react";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BrandMark } from "@/components/icons";
import type { AgentAvailabilityState } from "@shared/types";
import { getAgentHealth } from "./agentHealth";

export interface AgentOption {
  id: string;
  name: string;
  color: string;
  Icon: ComponentType<{ size?: number; style?: CSSProperties; className?: string }>;
  selected: boolean;
  availability: AgentAvailabilityState | undefined;
  dangerousEnabled: boolean;
  hasCustomFlags: boolean;
}

interface AgentSelectorDropdownProps {
  agentOptions: AgentOption[];
  activeSubtab: string;
  onSubtabChange: (id: string) => void;
}

type DropdownItem =
  { kind: "general"; id: "general" } | { kind: "agent"; id: string; agent: AgentOption };

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

  // On every opening too, not only when the cursor moves: reopening on the same
  // late-list agent would otherwise leave its row, and the rail marking it, off-screen.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      activeItemRef.current?.scrollIntoView({ block: "nearest" })
    );
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) setFilterQuery("");
  }, [open]);

  // The cursor opens on the page being shown, so Enter straight away is a no-op
  // rather than a jump back to General.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      const current = [GENERAL_ID, ...agentOptions.map((a) => a.id)].indexOf(activeSubtab);
      setActiveIndex(Math.max(0, current));
    }
    setOpen(next);
  };

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

  const selectedAgent =
    activeSubtab !== GENERAL_ID ? agentOptions.find((a) => a.id === activeSubtab) : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          data-testid="agent-selector-trigger"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 text-sm rounded-[var(--radius-md)]",
            "border border-border-strong bg-surface-canvas text-text-primary transition-colors",
            // Radix hands focus back to the trigger when the list closes, so a `focus:`
            // indicator stayed lit after every pick — accent only for keyboard focus.
            "focus:outline-hidden focus-visible:border-accent-primary"
          )}
        >
          {selectedAgent ? (
            <>
              <BrandMark brandColor={selectedAgent.color}>
                <selectedAgent.Icon size={16} />
              </BrandMark>
              <span className="flex-1 text-left truncate">{selectedAgent.name}</span>
              <AgentStatusMarks agent={selectedAgent} />
            </>
          ) : (
            <>
              <Settings2 size={16} className="text-text-secondary" />
              <span className="flex-1 text-left truncate">General</span>
            </>
          )}
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-text-secondary transition-transform",
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
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-default">
          <Search size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
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
            className="flex-1 min-w-0 text-xs bg-transparent text-text-primary placeholder:text-text-placeholder focus:outline-hidden"
          />
        </div>
        <div
          role="listbox"
          id="agent-selector-list"
          aria-label="Agents"
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
                id={`agent-selector-item-${item.id}`}
                role="option"
                // The palettes' contract (paletteRowStyles): `aria-selected` is the row
                // Enter acts on, drawn as a fill plus a leading rail; the page being
                // shown is `aria-current` with a check.
                aria-selected={isActive}
                aria-current={isSelected ? "page" : undefined}
                onClick={() => handleSelect(item.id)}
                onMouseEnter={() => setActiveIndex(index)}
                className={cn(
                  PALETTE_ROW_CLASS,
                  "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm text-text-primary",
                  isSelected && "font-medium"
                )}
              >
                {item.kind === "general" ? (
                  <>
                    <Settings2 size={16} className="shrink-0 text-text-secondary" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">General</div>
                      <div className="text-xs text-text-secondary truncate">Global settings</div>
                    </div>
                  </>
                ) : (
                  <>
                    <BrandMark brandColor={item.agent.color} className="shrink-0">
                      <item.agent.Icon size={16} />
                    </BrandMark>
                    <span className="flex-1 min-w-0 truncate">{item.agent.name}</span>
                    <AgentStatusMarks agent={item.agent} />
                  </>
                )}
                {isSelected && <Check size={12} className="shrink-0" aria-hidden="true" />}
              </div>
            );
          })}
          {items.length === 1 && filterQuery && (
            <div className="px-2 py-3 text-xs text-text-secondary text-center">
              No agents match "{filterQuery}"
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the picker says about an agent without opening it: whether it is usable on this
 * machine, and whether it skips permission prompts. Each is a glyph and words rather
 * than a coloured dot — a dot alone could not tell "not installed" from "blocked", and
 * said nothing at all to anyone who can't see its colour. Ready agents show nothing.
 */
function AgentStatusMarks({ agent }: { agent: AgentOption }) {
  const health = getAgentHealth(agent.availability);
  const statusLabel =
    health.kind === "attention" || health.kind === "missing" ? health.label : null;
  if (!statusLabel && !agent.dangerousEnabled) return null;
  return (
    <span className="flex shrink-0 items-center gap-3 font-normal">
      {agent.dangerousEnabled && (
        <span className="flex items-center gap-1" title="Skips permission prompts">
          <ShieldOff className="h-3.5 w-3.5 text-status-error" aria-hidden="true" />
          <span className="sr-only">Skips permission prompts</span>
        </span>
      )}
      {statusLabel && (
        <span className="flex items-center gap-1.5" data-agent-status={statusLabel}>
          {health.kind === "attention" && (
            <health.Icon className="h-3.5 w-3.5 text-status-warning" aria-hidden="true" />
          )}
          <span className="text-xs text-text-secondary">{statusLabel}</span>
        </span>
      )}
    </span>
  );
}
