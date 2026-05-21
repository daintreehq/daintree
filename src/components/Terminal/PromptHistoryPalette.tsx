import { useCallback, useEffect } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import {
  usePromptHistoryPalette,
  type UsePromptHistoryPaletteOptions,
} from "@/hooks/usePromptHistoryPalette";
import type { PromptHistoryEntry } from "@/store/commandHistoryStore";
import { cn } from "@/lib/utils";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function truncatePrompt(text: string, maxLen = 80): string {
  const firstLine = text.split("\n")[0] ?? "";
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "…";
}

interface PromptHistoryRowProps {
  item: PromptHistoryEntry;
  index: number;
  isSelected: boolean;
  onSelect: (item: PromptHistoryEntry) => void;
  onHoverIndex: (index: number) => void;
}

export function PromptHistoryRow({
  item,
  index,
  isSelected,
  onSelect,
  onHoverIndex,
}: PromptHistoryRowProps) {
  return (
    <button
      type="button"
      id={`prompt-history-option-${item.id}`}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={() => onHoverIndex(index)}
      role="option"
      aria-selected={isSelected}
      className={cn(
        "group relative w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm text-left transition-colors",
        "border border-transparent text-daintree-text/80",
        "hover:bg-overlay-subtle hover:text-daintree-text",
        "aria-selected:bg-overlay-soft aria-selected:border-overlay aria-selected:text-daintree-text",
        "aria-selected:before:absolute aria-selected:before:left-0 aria-selected:before:top-2 aria-selected:before:bottom-2",
        "aria-selected:before:w-[2px] aria-selected:before:bg-daintree-accent aria-selected:before:content-['']"
      )}
      onClick={() => onSelect(item)}
    >
      <span className="truncate font-mono text-xs">{truncatePrompt(item.prompt)}</span>
      <div className="flex items-center gap-2 shrink-0">
        {item.agentId && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-daintree-border text-daintree-text/60">
            {item.agentId}
          </span>
        )}
        <span className="text-[10px] text-daintree-text/40 transition-colors group-aria-selected:text-daintree-text/60">
          {formatRelativeTime(item.addedAt)}
        </span>
      </div>
    </button>
  );
}

export interface PromptHistoryPaletteProps extends UsePromptHistoryPaletteOptions {
  onOpenRef?: React.MutableRefObject<(() => void) | null>;
}

export function PromptHistoryPalette({ onOpenRef, ...props }: PromptHistoryPaletteProps) {
  const {
    isOpen,
    query,
    results,
    totalResults,
    selectedIndex,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
    confirmSelection,
    close,
    open,
    scope,
    toggleScope,
    selectEntry,
  } = usePromptHistoryPalette(props);

  useEffect(() => {
    if (!onOpenRef) return;
    onOpenRef.current = open;
    return () => {
      onOpenRef.current = null;
    };
  }, [onOpenRef, open]);

  const getItemId = useCallback((item: PromptHistoryEntry) => item.id, []);

  const renderItem = useCallback(
    (
      item: PromptHistoryEntry,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => (
      <PromptHistoryRow
        key={item.id}
        item={item}
        index={index}
        isSelected={isSelected}
        onSelect={selectEntry}
        onHoverIndex={onHoverIndex}
      />
    ),
    [selectEntry]
  );

  const footer = (
    <div className="flex items-center gap-3 w-full">
      <div className="flex-1 min-w-0">
        <PaletteFooterHints
          primaryHint={{ keys: ["↵"], label: "to recall" }}
          hints={[
            { keys: ["↑", "↓"], label: "navigate" },
            { keys: ["Esc"], label: "close" },
          ]}
        />
      </div>
      <button
        type="button"
        onClick={toggleScope}
        className="shrink-0 text-[11px] px-2 py-0.5 rounded-[var(--radius-sm)] bg-daintree-border/50 hover:bg-daintree-border text-daintree-text/60 hover:text-daintree-text/80 transition-colors"
      >
        {scope === "project" ? "This project" : "All projects"}
      </button>
    </div>
  );

  return (
    <SearchablePalette<PromptHistoryEntry>
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={totalResults}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={confirmSelection}
      onClose={close}
      onHoverIndex={setSelectedIndex}
      getItemId={getItemId}
      renderItem={renderItem}
      label="Prompt History"
      shortcut="Cmd+R"
      ariaLabel="Prompt history search"
      searchPlaceholder="Search prompt history"
      listId="prompt-history-list"
      itemIdPrefix="prompt-history-option"
      emptyMessage="No history yet"
      emptyContent={
        <p className="mt-2 text-xs text-daintree-text/40">
          History appears here as you send prompts to agents.
        </p>
      }
      footer={footer}
    />
  );
}
