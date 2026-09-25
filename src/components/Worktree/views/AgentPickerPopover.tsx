import { useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Button } from "@/components/ui/button";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { BrandMark } from "@/components/icons";
import { useListboxCursor } from "@/hooks/useListboxCursor";
import { resolveAgentIcon } from "@/config/agentIcons";
import { getBrandColorHex } from "@/lib/colorUtils";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FIELD_TRIGGER } from "./WorktreeFormLayout";
import type { FirstAgentOption } from "../hooks/useFirstAgentOptions";

interface AgentPickerPopoverProps {
  agents: FirstAgentOption[];
  selectedAgentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (id: string | null) => void;
  listId: string;
}

type AgentRowOption = { id: null; agent: null } | { id: string; agent: FirstAgentOption };

function AgentGlyph({ agent }: { agent: FirstAgentOption }) {
  const Icon = resolveAgentIcon(agent.iconId);
  return (
    <BrandMark brandColor={getBrandColorHex(agent.id)}>
      <Icon className="h-3.5 w-3.5" />
    </BrandMark>
  );
}

export function AgentPickerPopover({
  agents,
  selectedAgentId,
  open,
  onOpenChange,
  onSelectAgent,
  listId,
}: AgentPickerPopoverProps) {
  const options = useMemo<AgentRowOption[]>(
    () => [{ id: null, agent: null }, ...agents.map((agent) => ({ id: agent.id, agent }))],
    [agents]
  );
  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const handleSelect = (id: string | null) => {
    onSelectAgent(id);
    onOpenChange(false);
  };

  const { activeIndex, setActiveIndex, listRef, handleKeyDown } = useListboxCursor({
    itemCount: options.length,
    open,
    onSelect: (index) => {
      const option = options[index];
      if (option) handleSelect(option.id);
    },
    onClose: () => onOpenChange(false),
  });

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={`${listId}-trigger`}
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          className={FIELD_TRIGGER}
          onKeyDown={(event) => {
            if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              onOpenChange(true);
              return;
            }
            if (open) handleKeyDown(event);
          }}
        >
          <span className="flex items-center gap-2 truncate">
            {selectedAgent ? (
              <>
                <AgentGlyph agent={selectedAgent} />
                <span>{selectedAgent.name}</span>
              </>
            ) : (
              <span className="text-text-secondary">No agent</span>
            )}
          </span>
          <ChevronsUpDown className="text-text-secondary shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <ScrollShadow
          ref={listRef}
          id={listId}
          role="listbox"
          className="max-h-[300px]"
          scrollClassName="p-1"
        >
          {options.map((option, index) => {
            const isSelectedValue = option.id === selectedAgentId;
            return (
              <div
                key={option.id ?? "none"}
                id={optionId(index)}
                data-option-index={index}
                role="option"
                aria-selected={index === activeIndex}
                aria-current={isSelectedValue ? "true" : undefined}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => handleSelect(option.id)}
                className={cn(
                  PALETTE_ROW_CLASS,
                  "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer"
                )}
              >
                {option.agent ? (
                  <span className="flex items-center gap-2 min-w-0">
                    <AgentGlyph agent={option.agent} />
                    <span className="truncate">{option.agent.name}</span>
                  </span>
                ) : (
                  <span className="text-text-secondary">No agent</span>
                )}
                {isSelectedValue && (
                  <>
                    <Check className="h-4 w-4 shrink-0 text-text-primary" aria-hidden="true" />
                    <span className="sr-only">Currently selected</span>
                  </>
                )}
              </div>
            );
          })}
        </ScrollShadow>
      </PopoverContent>
    </Popover>
  );
}
