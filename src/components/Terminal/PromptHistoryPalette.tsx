import { useCallback, useEffect } from "react";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
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
  const firstLine = text.split("\n")[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "…";
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
    (item: PromptHistoryEntry, _index: number, isSelected: boolean) => (
      <div
        key={item.id}
        id={`prompt-history-option-${item.id}`}
        role="option"
        aria-selected={isSelected}
        className={cn(
          "flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] cursor-pointer text-sm",
          isSelected
            ? "bg-canopy-accent/15 text-canopy-text"
            : "text-canopy-text/80 hover:bg-canopy-sidebar"
        )}
        onClick={() => selectEntry(item)}
      >
        <span className="truncate font-mono text-xs">{truncatePrompt(item.prompt)}</span>
        <div className="flex items-center gap-2 shrink-0">
          {item.agentId && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canopy-border text-canopy-text/60">
              {item.agentId}
            </span>
          )}
          <span className="text-[10px] text-canopy-text/40">
            {formatRelativeTime(item.addedAt)}
          </span>
        </div>
      </div>
    ),
    [selectEntry]
  );

  const footer = (
    <div className="flex items-center justify-between w-full">
      <div className="flex items-center gap-4">
        <span>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
            ↑
          </kbd>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60 ml-1">
            ↓
          </kbd>
          <span className="ml-1.5">navigate</span>
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
            Enter
          </kbd>
          <span className="ml-1.5">select</span>
        </span>
      </div>
      <button
        type="button"
        onClick={toggleScope}
        className="text-[11px] px-2 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border/50 hover:bg-canopy-border text-canopy-text/60 hover:text-canopy-text/80 transition-colors"
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
      getItemId={getItemId}
      renderItem={renderItem}
      label="Prompt History"
      keyHint="⌘R"
      ariaLabel="Prompt history search"
      searchPlaceholder="Search prompt history..."
      listId="prompt-history-list"
      itemIdPrefix="prompt-history-option"
      emptyMessage="No history yet"
      noMatchMessage="No prompts match your search"
      footer={footer}
    />
  );
}
