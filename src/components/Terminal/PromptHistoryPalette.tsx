import { useCallback, useEffect } from "react";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { KbdChord } from "@/components/ui/Kbd";
import { SegmentedToggle, type SegmentedToggleOption } from "@/components/ui/SegmentedToggle";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import {
  usePromptHistoryPalette,
  type HistoryScope,
  type PromptHistoryItem,
  type UsePromptHistoryPaletteOptions,
} from "@/hooks/usePromptHistoryPalette";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { excerptPreview, findPreviewMatches } from "@/utils/promptHistoryPreview";
import { formatTimeAgo } from "@/utils/timeAgo";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";

/**
 * The composer opens this palette with Mod+R (`inputEditorExtensions/base.ts`),
 * a CodeMirror binding rather than a registry one, so the chord is literal.
 * Pressing it again while the palette is open switches scope — the chord in the
 * header is then the key for the control in the footer.
 */
const SHORTCUT = "Cmd+R";

const SCOPE_TITLE = `Switch scope (${isMac() ? "⌘R" : "Ctrl+R"})`;

const SCOPE_OPTIONS: SegmentedToggleOption<HistoryScope>[] = [
  { value: "project", label: "This project", title: SCOPE_TITLE },
  { value: "global", label: "All projects", title: SCOPE_TITLE },
];

interface PromptHistoryRowProps {
  item: PromptHistoryItem;
  index: number;
  isSelected: boolean;
  query: string;
  matches: readonly FuseResultMatch[] | undefined;
  onSelect: (item: PromptHistoryItem) => void;
  onHoverIndex: (index: number) => void;
}

export function PromptHistoryRow({
  item,
  index,
  isSelected,
  query,
  matches,
  onSelect,
  onHoverIndex,
}: PromptHistoryRowProps) {
  const fuzzyRanges = matches?.find((m) => m.key === "preview")?.indices;
  const excerpt = excerptPreview(
    item.preview,
    query.trim() ? findPreviewMatches(item.preview, query, fuzzyRanges) : undefined
  );
  const agentConfig = item.agentId ? getEffectiveAgentConfig(item.agentId) : undefined;
  const agentName = item.agentId ? (agentConfig?.name ?? item.agentId) : null;
  const targets = item.armedIds?.length ?? 0;
  // What the history recorded about the send, never what recalling it will do:
  // recall puts the text in this composer and nothing else.
  const meta = [
    item.lineCount > 1 ? `${item.lineCount} lines` : null,
    targets > 1 ? `${targets} panes` : null,
  ].filter(Boolean);

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
        PALETTE_ROW_CLASS,
        "w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary"
      )}
      onClick={() => onSelect(item)}
    >
      {/* The terminal glyph for a prompt whose agent was never recorded: it was
          sent to a pane, and that is all the history knows. */}
      <PanelKindIcon
        iconId={agentConfig?.iconId ?? item.agentId ?? "terminal"}
        color={agentConfig?.color}
        size={16}
      />
      <span className="flex-1 min-w-0 truncate text-sm font-medium text-text-primary">
        <HighlightedText text={excerpt.text} indices={excerpt.indices} />
      </span>
      {/* After the prompt, so the option's name starts with the text on screen. */}
      {agentName && <span className="sr-only">, sent to {agentName}</span>}
      {meta.length > 0 && (
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          {meta.join(" · ")}
        </span>
      )}
      <span className="shrink-0 min-w-14 text-right text-xs text-text-secondary tabular-nums">
        {formatTimeAgo(item.addedAt)}
      </span>
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
    matchesById,
    isStale,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
    confirmSelection,
    close,
    open,
    scope,
    setScope,
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

  const getItemId = useCallback((item: PromptHistoryItem) => item.id, []);

  const renderItem = useCallback(
    (
      item: PromptHistoryItem,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void,
      matches: readonly FuseResultMatch[] | undefined
    ) => (
      <PromptHistoryRow
        key={item.id}
        item={item}
        index={index}
        isSelected={isSelected}
        query={query}
        matches={matches}
        onSelect={selectEntry}
        onHoverIndex={onHoverIndex}
      />
    ),
    [selectEntry, query]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        toggleScope();
      }
    },
    [toggleScope]
  );

  const hasSelection = selectedIndex >= 0 && selectedIndex < results.length;

  const footer = (
    <div className="flex items-center gap-3 w-full">
      <div className="flex-1 min-w-0">
        {/* Only while Enter would recall something. */}
        {hasSelection && <PaletteFooterHints primaryHint={{ keys: ["↵"], label: "to recall" }} />}
      </div>
      {/* Pointer-down is held so a click switches scope without taking focus
          out of the search field — the list keys live there. */}
      <div
        className="flex shrink-0 items-center gap-2"
        onPointerDownCapture={(e) => e.preventDefault()}
      >
        {/* The chord that opened the palette, named here as the key for this
            control — Tab moves the list selection, so this is the keyboard
            route to it. */}
        <KbdChord shortcut={SHORTCUT} aria-label={SCOPE_TITLE} />
        <SegmentedToggle
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={setScope}
          density="compact"
          ariaLabel="History scope"
        />
      </div>
    </div>
  );

  return (
    <SearchablePalette<PromptHistoryItem>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={totalResults}
      selectedIndex={selectedIndex}
      matchesById={matchesById}
      isFiltering={isStale}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={confirmSelection}
      onClose={close}
      onHoverIndex={setSelectedIndex}
      onKeyDown={handleKeyDown}
      getItemId={getItemId}
      renderItem={renderItem}
      label="Prompt history"
      shortcut={SHORTCUT}
      ariaLabel="Prompt history search"
      searchPlaceholder="Search sent prompts…"
      searchAriaLabel="Search prompt history"
      listId="prompt-history-list"
      itemIdPrefix="prompt-history-option"
      emptyMessage={
        scope === "project" ? "No prompts sent in this project yet" : "No prompts sent yet"
      }
      emptyContent={
        <p className="mt-2 text-xs text-text-secondary">
          Send a prompt to an agent and it appears here, ready to reuse.
        </p>
      }
      footer={footer}
    />
  );
}
