import { useCallback, useEffect, useMemo, useRef } from "react";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { KbdChord } from "@/components/ui/Kbd";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import {
  usePromptHistoryPalette,
  type HistoryScope,
  type PromptHistoryItem,
  type UsePromptHistoryPaletteOptions,
} from "@/hooks/usePromptHistoryPalette";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import {
  excerptPreview,
  findPreviewMatches,
  mapPreviewRangesToPrompt,
} from "@/utils/promptHistoryPreview";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/projectStore";
import { usePaletteStore } from "@/store/paletteStore";
import { GLOBAL_ASSISTANT_HISTORY_ID } from "@/store/commandHistoryStore";
import { isMac } from "@/lib/platform";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { pluralize } from "@/lib/pluralize";

/**
 * The composer opens this palette with Mod+R (`inputEditorExtensions/base.ts`),
 * a CodeMirror binding rather than a registry one, so the chord is literal.
 * Pressing it again while the palette is open switches scope — the chord in the
 * header is then the key for the control in the footer.
 */
const SHORTCUT = "Cmd+R";

const SCOPE_HINT_ID = "prompt-history-scope-hint";
const PREVIEW_ID = "prompt-history-preview";
const PREVIEW_HINT_ID = "prompt-history-preview-hint";
/** The preview's scroller, which Page Up and Page Down move from the search field. */
const PREVIEW_SCROLL_ID = "prompt-history-preview-scroll";

/**
 * How many characters fit before the list column's ellipsis, for anchoring an
 * excerpt on its match: the column is narrower than the 608px palette's rows.
 */
const ROW_EXCERPT = { visibleChars: 34, leadChars: 12 };

/** The list column beside the preview; the results take the full width when there's nothing to preview. */
const LIST_COLUMN_CLASS = "w-[25rem] shrink-0 max-[900px]:w-full max-[900px]:max-h-[30vh]";

const SCOPE_TITLE = `Switch scope (${isMac() ? "⌘R" : "Ctrl+R"})`;

const SCOPE_OPTIONS: SegmentedRadioOption<HistoryScope>[] = [
  { value: "project", label: "This project", tooltip: SCOPE_TITLE },
  { value: "global", label: "All projects", tooltip: SCOPE_TITLE },
];

/**
 * What the history recorded about the send, never what recalling it will do:
 * recall puts the text in this composer and nothing else.
 */
function promptHistoryCounts(item: PromptHistoryItem): string[] {
  const targets = item.armedIds?.length ?? 0;
  return [
    item.lineCount > 1 ? pluralize(item.lineCount, "line") : null,
    targets > 1 ? pluralize(targets, "terminal") : null,
  ].filter((fact): fact is string => fact !== null);
}

interface PromptHistoryRowProps {
  item: PromptHistoryItem;
  index: number;
  isSelected: boolean;
  query: string;
  matches: readonly FuseResultMatch[] | undefined;
  /** Set only in the all-projects scope, where it is what tells two lists' prompts apart. */
  projectName?: string | null;
  onSelect: (item: PromptHistoryItem) => void;
  onHoverIndex: (index: number) => void;
}

export function PromptHistoryRow({
  item,
  index,
  isSelected,
  query,
  matches,
  projectName,
  onSelect,
  onHoverIndex,
}: PromptHistoryRowProps) {
  const fuzzyRanges = matches?.find((m) => m.key === "preview")?.indices;
  const excerpt = excerptPreview(
    item.preview,
    query.trim() ? findPreviewMatches(item.preview, query, fuzzyRanges) : undefined,
    ROW_EXCERPT
  );
  const agentConfig = item.agentId ? getEffectiveAgentConfig(item.agentId) : undefined;
  const agentName = item.agentId ? (agentConfig?.name ?? item.agentId) : null;
  const counts = promptHistoryCounts(item);

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
        "w-full flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-md)] text-left",
        "text-text-secondary"
      )}
      onClick={() => onSelect(item)}
    >
      {/* The terminal glyph for a prompt whose agent was never recorded: it was
          sent to a pane, and that is all the history knows. */}
      <PanelKindIcon iconId={item.agentId ?? "terminal"} color={agentConfig?.color} size={16} />
      <span className="flex-1 min-w-0 truncate text-sm font-medium text-text-primary">
        <HighlightedText text={excerpt.text} indices={excerpt.indices} />
      </span>
      {/* After the prompt, so the option's name starts with the text on screen. */}
      {agentName && <span className="sr-only">, sent to {agentName}</span>}
      {/* The column beside the preview has no room for them, so they are shown
          there; the option's name still carries them. */}
      {(projectName || counts.length > 0) && (
        <span className="sr-only">, {[projectName, ...counts].filter(Boolean).join(", ")}</span>
      )}
      <TimeAgo
        timestamp={item.addedAt}
        className="shrink-0 min-w-14 text-right text-xs text-text-secondary"
      />
    </button>
  );
}

interface PromptHistoryPreviewProps {
  item: PromptHistoryItem;
  query: string;
  matches: readonly FuseResultMatch[] | undefined;
  projectName?: string | null;
}

/**
 * The selected prompt as it was sent, beside the list: line breaks kept, the
 * query's literal matches marked, and what the history recorded about the send.
 * Outside the listbox and not live, so arrow presses keep announcing the row.
 */
export function PromptHistoryPreview({
  item,
  query,
  matches,
  projectName,
}: PromptHistoryPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const q = query.trim();
  const fuzzyRanges = matches?.find((m) => m.key === "preview")?.indices;
  // Literal hits in the raw text; a typo, which only the scorer's ranges over the
  // one-line preview explain, is carried back to where they sit in the prompt.
  const ranges = useMemo(() => {
    if (!q) return undefined;
    const literal = findPreviewMatches(item.prompt, q, undefined);
    if (literal) return literal;
    return mapPreviewRangesToPrompt(
      item.prompt,
      item.preview,
      findPreviewMatches(item.preview, q, fuzzyRanges)
    );
  }, [item.prompt, item.preview, q, fuzzyRanges]);
  const firstMatch = ranges?.reduce<number | null>(
    (first, [start]) => (first === null || start < first ? start : first),
    null
  );
  const agentConfig = item.agentId ? getEffectiveAgentConfig(item.agentId) : undefined;
  const agentName = item.agentId ? (agentConfig?.name ?? item.agentId) : null;
  const targets = item.armedIds?.length ?? 0;

  // A new selection starts at the top; a search starts at its first match,
  // which a long prompt can hold well below the fold.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const mark =
      firstMatch !== null && firstMatch !== undefined
        ? scroller.querySelector("[data-highlight]")
        : null;
    scroller.scrollTop =
      mark instanceof HTMLElement ? Math.max(0, mark.offsetTop - scroller.offsetTop - 12) : 0;
  }, [item.id, q, firstMatch]);

  return (
    <div
      id={PREVIEW_ID}
      role="region"
      aria-label="Selected prompt"
      className={cn(
        "flex min-w-0 flex-1 flex-col border-l border-border-strong",
        "max-[900px]:border-l-0 max-[900px]:border-t"
      )}
    >
      <ScrollShadow
        ref={scrollRef}
        id={PREVIEW_SCROLL_ID}
        className="max-h-[60vh] flex-1 max-[900px]:max-h-[34vh]"
        scrollClassName="px-4 py-3"
      >
        {/* One child, so the scroll fade follows the text's height as the selection changes. */}
        <div>
          <dl className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-text-secondary">Sent</dt>
            <dd className="text-text-primary">
              <TimeAgo timestamp={item.addedAt} />
            </dd>
            {agentName && (
              <>
                <dt className="text-text-secondary">Agent</dt>
                <dd className="flex min-w-0 items-center gap-1.5 text-text-primary">
                  <PanelKindIcon
                    iconId={item.agentId ?? "terminal"}
                    color={agentConfig?.color}
                    size={12}
                  />
                  <span className="min-w-0 break-words">{agentName}</span>
                </dd>
              </>
            )}
            {projectName && (
              <>
                <dt className="text-text-secondary">Project</dt>
                <dd className="min-w-0 break-words text-text-primary">{projectName}</dd>
              </>
            )}
            {targets > 1 && (
              <>
                <dt className="text-text-secondary">Sent to</dt>
                <dd className="text-text-primary">{pluralize(targets, "terminal")}</dd>
              </>
            )}
            {item.lineCount > 1 && (
              <>
                <dt className="text-text-secondary">Length</dt>
                <dd className="text-text-primary">{pluralize(item.lineCount, "line")}</dd>
              </>
            )}
          </dl>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-primary">
            <HighlightedText text={item.prompt} indices={ranges} />
          </p>
        </div>
      </ScrollShadow>
    </div>
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
    projectless,
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

  // Mounted, open or not: the Action Palette's `:` hands off only while some
  // composer draws this palette to answer it.
  useEffect(() => usePaletteStore.getState().registerPromptHistoryHost(), []);

  const projects = useProjectStore((s) => s.projects);
  const projectNames = useMemo(
    () =>
      scope === "global"
        ? new Map([
            ...projects.map((p) => [p.id, p.name] as const),
            [GLOBAL_ASSISTANT_HISTORY_ID, "Global assistant"] as const,
          ])
        : null,
    [scope, projects]
  );

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
        projectName={projectNames?.get(item.projectId)}
        onSelect={selectEntry}
        onHoverIndex={onHoverIndex}
      />
    ),
    [selectEntry, query, projectNames]
  );

  const getDetail = useCallback(
    (item: PromptHistoryItem | null) =>
      item ? (
        <PromptHistoryPreview
          item={item}
          query={query}
          matches={matchesById.get(item.id)}
          projectName={projectNames?.get(item.projectId)}
        />
      ) : null,
    [query, matchesById, projectNames]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        toggleScope();
        return;
      }
      // The preview scrolls from the search field, which keeps the keyboard.
      if (e.key === "PageDown" || e.key === "PageUp") {
        const scroller = document.getElementById(PREVIEW_SCROLL_ID);
        if (!scroller) return;
        e.preventDefault();
        const page = scroller.clientHeight * 0.85;
        scroller.scrollBy({ top: e.key === "PageDown" ? page : -page, behavior: "instant" });
      }
    },
    [toggleScope]
  );

  const hasSelection = selectedIndex >= 0 && selectedIndex < results.length;

  const footer = (
    <div className="flex items-center gap-3 w-full">
      <div className="flex-1 min-w-0">
        {/* Only while Enter would recall something. */}
        {hasSelection && <PaletteFooterHints primaryHint={{ keys: "Enter", label: "to recall" }} />}
      </div>
      {/* Pointer-down is held so a click switches scope without taking focus
          out of the search field — the list keys live there. A composer with
          no project's history of its own has no scope to switch to. */}
      {!projectless && (
        <div
          className="flex shrink-0 items-center gap-2"
          onPointerDownCapture={(e) => e.preventDefault()}
        >
          {/* The chord that opened the palette, named here as the key for this
            control — the route to it that doesn't leave the search field. */}
          <KbdChord shortcut={SHORTCUT} aria-label={SCOPE_TITLE} />
          <span id={SCOPE_HINT_ID} className="sr-only">
            {scope === "project"
              ? "Showing this project's prompts."
              : "Showing every project's prompts."}{" "}
            {SCOPE_TITLE}.
          </span>
          <SegmentedRadioGroup
            options={SCOPE_OPTIONS}
            value={scope}
            onChange={setScope}
            density="compact"
            aria-label="History scope"
          />
        </div>
      )}
    </div>
  );

  return (
    <SearchablePalette<PromptHistoryItem>
      tier="workspace"
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
      searchAriaDescribedBy={projectless ? PREVIEW_HINT_ID : `${SCOPE_HINT_ID} ${PREVIEW_HINT_ID}`}
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
      getDetail={getDetail}
      bodyClassName={results.length > 0 ? LIST_COLUMN_CLASS : undefined}
      afterList={
        <span id={PREVIEW_HINT_ID} className="sr-only">
          The selected prompt is shown in full beside the list. Page Up and Page Down scroll it.
        </span>
      }
    />
  );
}
