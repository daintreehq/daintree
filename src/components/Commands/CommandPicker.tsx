import { useState, useMemo, useEffect, useCallback, useDeferredValue } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS, PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { paletteSummary } from "@/lib/paletteSummary";
import type { CommandManifestEntry, CommandCategory } from "@shared/types/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PluginPromptTemplate } from "@/store/pluginRuntimeStore";

interface CommandPickerProps {
  isOpen: boolean;
  commands: CommandManifestEntry[];
  isLoading?: boolean;
  /** Why the command list couldn't be read. Shown only when nothing is cached. */
  loadError?: string | null;
  onRetryLoad?: () => void;
  onSelect: (command: CommandManifestEntry) => void;
  onDismiss: () => void;
  filter?: CommandCategory[];
  /** Plugin prompt templates, listed after the host commands. They fill the draft; they run nothing. */
  templates?: readonly PluginPromptTemplate[];
  onSelectTemplate?: (template: PluginPromptTemplate) => void;
}

interface TemplateRow {
  kind: "template";
  entry: PluginPromptTemplate;
}

// A host command stays the bare manifest entry, so everything that reads the
// picker's results as commands keeps working; a template is the tagged case.
type PickerRow = CommandManifestEntry | TemplateRow;

function isTemplateRow(row: PickerRow): row is TemplateRow {
  return "kind" in row && row.kind === "template";
}

// A module constant: an inline `[]` default is a new array every render and would
// rebuild the rows, resetting the highlight, on each one.
const NO_TEMPLATES: readonly PluginPromptTemplate[] = [];

const TEMPLATE_BAND_LABEL = "Prompt templates";

function rowKey(row: PickerRow): string {
  return isTemplateRow(row) ? `template:${row.entry.key}` : row.id;
}

function isRowEnabled(row: PickerRow): boolean {
  return isTemplateRow(row) || row.enabled;
}

/** What Enter does to a template: ask for its arguments, or fill the draft at once. */
export function getTemplateActionLabel(entry: PluginPromptTemplate): string {
  return entry.template.args.length > 0 ? "Open form" : "Fill draft";
}

/**
 * How well a template answers a query, or null when it does not. Every term
 * must land in the title, the plugin's name or the description; a title hit
 * ranks above the rest, as a command name does for a command.
 */
export function scoreTemplate(entry: PluginPromptTemplate, query: string): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const title = entry.template.title.toLowerCase();
  const titleWords = title.split(/[^a-z0-9]+/);
  const pluginWords = entry.pluginName.toLowerCase().split(/[^a-z0-9]+/);
  const descriptionWords = entry.template.description.toLowerCase().split(/[^a-z0-9]+/);

  let total = 0;
  for (const term of terms) {
    if (title.startsWith(term)) total += 8;
    else if (titleWords.some((w) => w.startsWith(term))) total += 6;
    else if (title.includes(term)) total += 4;
    else if (pluginWords.some((w) => w.startsWith(term))) total += 3;
    else if (descriptionWords.some((w) => w.startsWith(term))) total += 2;
    else return null;
  }
  return total;
}

const CATEGORY_ORDER: CommandCategory[] = ["github", "git", "workflow", "project", "system"];

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  github: "GitHub",
  git: "Git",
  workflow: "Workflow",
  project: "Project",
  system: "System",
};

/**
 * What Enter does to the highlighted row. A builder command opens its form
 * first (`CommandPickerHost`), anything else runs on the spot — and an
 * unavailable row does nothing, so it gets no hint at all.
 */
export function getCommandActionLabel(cmd: CommandManifestEntry): string | null {
  if (!cmd.enabled) return null;
  return cmd.hasBuilder ? "Open form" : "Run command";
}

/**
 * How well a command answers a query, or null when it does not.
 *
 * Every term must land somewhere, and where it lands sets the rank: the command
 * name first, then its keywords, then a word in its description. Letters
 * scattered through the name still count, so `ghwi` finds `github:work-issue`,
 * but that is the weakest match and never reaches into the description — a
 * subsequence over a paragraph matches nearly any short query, which left
 * unrelated commands in the list and the wrong one under Enter.
 */
export function scoreCommand(cmd: CommandManifestEntry, query: string): number | null {
  const terms = query.toLowerCase().split(/\s+/).map(stripCommandSlash).filter(Boolean);
  if (terms.length === 0) return 0;

  const id = cmd.id.toLowerCase();
  const idParts = id.split(/[:\-_.]/);
  const keywords = (cmd.keywords ?? []).map((k) => k.toLowerCase());
  const descriptionWords = cmd.description.toLowerCase().split(/[^a-z0-9]+/);

  let total = 0;
  for (const term of terms) {
    if (id.startsWith(term)) total += 8;
    else if (idParts.some((part) => part.startsWith(term))) total += 6;
    else if (id.includes(term)) total += 4;
    else if (keywords.some((k) => k.startsWith(term))) total += 3;
    else if (descriptionWords.some((w) => w.startsWith(term))) total += 2;
    else if (term.length > 1 && isSubsequence(term, id)) total += 1;
    else return null;
  }
  return total;
}

/**
 * Rows print each command as `/github:work-issue`, so a query typed or pasted
 * the way it reads must find it. The slash is presentation, not part of the id.
 */
function stripCommandSlash(term: string): string {
  return term.replace(/^\/+/, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

type Range = readonly [number, number];

/**
 * Where each query term landed in `text`, for match emphasis — the same places
 * `scoreCommand` looks: a word start first, then anywhere, and for the command
 * name only, letters in order. A term that matched only a keyword has nothing
 * visible to point at and marks nothing.
 */
export function matchRanges(text: string, query: string, allowScattered: boolean): Range[] {
  const lower = text.toLowerCase();
  const ranges: Range[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const term = stripCommandSlash(raw);
    if (!term) continue;
    let at = -1;
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
      if (i === 0 || !/[a-z0-9]/.test(lower[i - 1]!)) {
        at = i;
        break;
      }
    }
    if (at === -1) at = lower.indexOf(term);
    if (at !== -1) {
      ranges.push([at, at + term.length - 1]);
      continue;
    }
    if (!allowScattered) continue;
    const scattered: Range[] = [];
    let j = 0;
    for (let i = 0; i < lower.length && j < term.length; i++) {
      if (lower[i] === term[j]) {
        scattered.push([i, i]);
        j++;
      }
    }
    if (j === term.length) ranges.push(...scattered);
  }
  return ranges;
}

const LOAD_ERROR_TITLE = "Couldn't load commands";
const LOAD_ERROR_DETAIL_ID = "command-load-error-detail";
const LOAD_ERROR_HINT_ID = "command-load-error-hint";

function firstEnabledIndex(rows: PickerRow[]): number {
  const index = rows.findIndex(isRowEnabled);
  return index === -1 ? 0 : index;
}

function EmptyHint() {
  return (
    <p className="mt-2 text-xs text-text-secondary">
      Press <kbd className={KBD_CLASS}>Esc</kbd> to go back to the composer
    </p>
  );
}

function BandLabel({ label, first }: { label: string; first: boolean }) {
  // A band label, not a row: listbox children must be options, and
  // role="group" loses its label under Chromium + VoiceOver, so it
  // stands as an inert option that the arrow keys never reach
  // (it is not in `results`). Same shape as the action palette.
  return (
    <div
      role="option"
      aria-disabled="true"
      aria-selected="false"
      aria-label={label}
      className={cn(PALETTE_SECTION_LABEL_CLASS, "px-3 pb-1 pt-1", !first && "mt-2")}
    >
      {label}
    </div>
  );
}

export function CommandPicker({
  isOpen,
  commands,
  isLoading = false,
  loadError = null,
  onRetryLoad,
  onSelect,
  onDismiss,
  filter,
  templates = NO_TEMPLATES,
  onSelectTemplate,
}: CommandPickerProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const deferredQuery = useDeferredValue(query);
  const isStale = query !== deferredQuery;
  // A bare `/` is how a slash command starts, not a search: keep browsing.
  const trimmedQuery = deferredQuery.split(/\s+/).map(stripCommandSlash).join(" ").trim();

  const available = useMemo(
    () =>
      filter && filter.length > 0
        ? commands.filter((cmd) => filter.includes(cmd.category))
        : commands,
    [commands, filter]
  );

  // A category filter narrows the host commands to a kind of work; templates
  // belong to none of them.
  const offeredTemplates = useMemo(
    () => (filter && filter.length > 0 ? [] : templates),
    [templates, filter]
  );

  // Browsing reads by category; a search reads by relevance. Category bands
  // stay only while nothing is typed — ranked results under bands would put the
  // best match wherever its category happened to sort, not first under Enter.
  const { flatRows, bandStarts } = useMemo(() => {
    const starts = new Map<string, string>();
    if (trimmedQuery) {
      const candidates: { row: PickerRow; score: number | null }[] = [
        ...available.map((cmd) => ({
          row: cmd as PickerRow,
          score: scoreCommand(cmd, trimmedQuery),
        })),
        ...offeredTemplates.map((entry) => ({
          row: { kind: "template", entry } as PickerRow,
          score: scoreTemplate(entry, trimmedQuery),
        })),
      ];
      const ranked = candidates
        .map((c, order) => ({ ...c, order }))
        .filter((c): c is { row: PickerRow; score: number; order: number } => c.score !== null)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map((c) => c.row);
      return { flatRows: ranked, bandStarts: starts };
    }

    const flat: PickerRow[] = [];
    for (const category of CATEGORY_ORDER) {
      const inCategory = available.filter((cmd) => cmd.category === category);
      if (inCategory.length === 0) continue;
      starts.set(inCategory[0]!.id, CATEGORY_LABELS[category]);
      flat.push(...inCategory);
    }
    if (offeredTemplates.length > 0) {
      const rows = offeredTemplates.map((entry): PickerRow => ({ kind: "template", entry }));
      starts.set(rowKey(rows[0]!), TEMPLATE_BAND_LABEL);
      flat.push(...rows);
    }
    return { flatRows: flat, bandStarts: starts };
  }, [available, offeredTemplates, trimmedQuery]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
    }
  }, [isOpen]);

  // Unavailable rows stay in the arrow-key path so their reason can be reached
  // and read, but the highlight starts on the first command Enter can run.
  useEffect(() => {
    setSelectedIndex(firstEnabledIndex(flatRows));
  }, [flatRows, isOpen]);

  const handleSelectPrevious = useCallback(() => {
    setSelectedIndex((prev) =>
      flatRows.length === 0 ? 0 : (prev - 1 + flatRows.length) % flatRows.length
    );
  }, [flatRows]);

  const handleSelectNext = useCallback(() => {
    setSelectedIndex((prev) => (flatRows.length === 0 ? 0 : (prev + 1) % flatRows.length));
  }, [flatRows]);

  const activate = useCallback(
    (row: PickerRow | undefined) => {
      // While the deferred filter is catching up, results may not match the input.
      // No-op and wait for the next render; a repeat Enter lands on the right item.
      if (isStale || !row || !isRowEnabled(row)) return;
      if (isTemplateRow(row)) onSelectTemplate?.(row.entry);
      else onSelect(row);
    },
    [isStale, onSelect, onSelectTemplate]
  );

  // A failed list with nothing cached reads as an empty catalogue unless it says
  // otherwise; a cached list stays usable through a failed refresh.
  const showLoadError =
    loadError !== null && commands.length === 0 && offeredTemplates.length === 0 && !isLoading;

  const loadErrorContent = showLoadError ? (
    <div className="mt-2 flex flex-col items-center gap-3">
      <p id={LOAD_ERROR_DETAIL_ID} className="max-w-md text-xs text-text-secondary">
        {loadError}
      </p>
      {/* The footer shows this to the eye; the field reads it out, since focus
          never leaves it and the empty state announces only its title. */}
      <span id={LOAD_ERROR_HINT_ID} className="sr-only">
        Press Enter to retry
      </span>
      {onRetryLoad && (
        <Button
          size="sm"
          variant="outline"
          // Keeps focus in the search field: the button leaves with this state
          // the moment the retry starts, and Enter there retries again.
          onPointerDown={(e) => e.preventDefault()}
          onClick={onRetryLoad}
        >
          Retry
        </Button>
      )}
    </div>
  ) : null;

  const handleConfirm = useCallback(() => {
    // Focus stays in the search field, so Enter is the keyboard's Retry.
    if (showLoadError) {
      onRetryLoad?.();
      return;
    }
    activate(flatRows[selectedIndex]);
  }, [activate, flatRows, selectedIndex, showLoadError, onRetryLoad]);

  const setSize = flatRows.length;

  return (
    <SearchablePalette<PickerRow>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={flatRows}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={handleSelectPrevious}
      onSelectNext={handleSelectNext}
      onConfirm={handleConfirm}
      onClose={onDismiss}
      onHoverIndex={setSelectedIndex}
      getItemId={rowKey}
      getActionLabel={(row) =>
        isTemplateRow(row) ? getTemplateActionLabel(row.entry) : getCommandActionLabel(row)
      }
      isLoading={isLoading}
      isFiltering={isStale}
      renderItem={(row, index, isSelected, onHoverIndex) => {
        const band = bandStarts.get(rowKey(row));
        if (isTemplateRow(row)) {
          const { entry } = row;
          const domId = `command-template-${entry.key}`;
          const titleId = `${domId}-title`;
          const summaryId = `${domId}-summary`;
          const sourceId = `${domId}-source`;
          const formId = `${domId}-form`;
          const opensForm = entry.template.args.length > 0;
          const summary = paletteSummary(entry.template.description);
          return (
            <div key={rowKey(row)}>
              {band && <BandLabel label={band} first={index === 0} />}
              <div
                id={domId}
                data-template-key={entry.key}
                role="option"
                aria-selected={isSelected}
                aria-posinset={index + 1}
                aria-setsize={setSize}
                aria-labelledby={titleId}
                aria-describedby={[sourceId, summaryId, opensForm && formId]
                  .filter(Boolean)
                  .join(" ")}
                aria-haspopup={opensForm ? "dialog" : undefined}
                onPointerDown={(e) => e.preventDefault()}
                onPointerMove={() => onHoverIndex(index)}
                onClick={() => activate(row)}
                className={cn(
                  PALETTE_ROW_CLASS,
                  "flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 rounded-[var(--radius-md)] text-left text-text-secondary"
                )}
              >
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span id={titleId} className="min-w-0 truncate text-sm text-text-primary">
                    <HighlightedText
                      text={entry.template.title}
                      indices={
                        trimmedQuery
                          ? matchRanges(entry.template.title, trimmedQuery, false)
                          : undefined
                      }
                    />
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {opensForm && (
                      <Badge id={formId} size="xs" className="shrink-0">
                        Opens form
                      </Badge>
                    )}
                    <span id={sourceId} className="max-w-40 truncate text-xs text-text-secondary">
                      {entry.pluginName}
                    </span>
                  </span>
                </div>
                <div id={summaryId} className="truncate text-xs text-text-secondary">
                  <HighlightedText
                    text={summary}
                    indices={trimmedQuery ? matchRanges(summary, trimmedQuery, false) : undefined}
                  />
                </div>
              </div>
            </div>
          );
        }
        const cmd = row;
        const category = band;
        const titleId = `command-${cmd.id}-title`;
        const summaryId = `command-${cmd.id}-summary`;
        const reasonId = `command-${cmd.id}-reason`;
        const formId = `command-${cmd.id}-form`;
        const opensForm = cmd.hasBuilder && cmd.enabled;
        const reason = !cmd.enabled ? cmd.disabledReason : undefined;
        const summary = paletteSummary(cmd.description);
        return (
          <div key={cmd.id}>
            {category && <BandLabel label={category} first={index === 0} />}
            <div
              id={`command-${cmd.id}`}
              data-command-id={cmd.id}
              role="option"
              aria-selected={isSelected}
              aria-disabled={!cmd.enabled}
              aria-posinset={index + 1}
              aria-setsize={setSize}
              aria-labelledby={titleId}
              // The badge is described, not hidden: it is the only thing that
              // separates a command that asks for more from one that runs now.
              aria-describedby={[summaryId, opensForm && formId, reason && reasonId]
                .filter(Boolean)
                .join(" ")}
              aria-haspopup={opensForm ? "dialog" : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onPointerMove={() => onHoverIndex(index)}
              onClick={() => activate(row)}
              className={cn(
                PALETTE_ROW_CLASS,
                "flex w-full flex-col gap-0.5 px-3 py-2 rounded-[var(--radius-md)] text-left text-text-secondary",
                cmd.enabled ? "cursor-pointer" : "cursor-not-allowed"
              )}
            >
              <div className="flex min-w-0 items-center justify-between gap-3">
                {/* Unavailable steps the name down the ramp rather than fading
                    the row: opacity took the reason line with it, and that is
                    the one line on the row that has to be read. */}
                <span
                  id={titleId}
                  className={cn(
                    "min-w-0 truncate font-mono text-sm",
                    cmd.enabled ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  /
                  <HighlightedText
                    text={cmd.id}
                    indices={trimmedQuery ? matchRanges(cmd.id, trimmedQuery, true) : undefined}
                  />
                </span>
                {/* Only where it is true: an unavailable row opens nothing. */}
                {opensForm && (
                  <Badge id={formId} size="xs" className="shrink-0">
                    Opens form
                  </Badge>
                )}
              </div>
              <div id={summaryId} className="truncate text-xs text-text-secondary">
                <HighlightedText
                  text={summary}
                  indices={trimmedQuery ? matchRanges(summary, trimmedQuery, false) : undefined}
                />
              </div>
              {reason && (
                <div id={reasonId} className="text-xs italic text-text-secondary">
                  {reason}
                </div>
              )}
            </div>
          </div>
        );
      }}
      label="Commands"
      ariaLabel="Command picker"
      searchPlaceholder="Search commands"
      searchAriaLabel="Search commands"
      searchAriaDescribedBy={
        showLoadError ? `${LOAD_ERROR_DETAIL_ID} ${LOAD_ERROR_HINT_ID}` : undefined
      }
      listId="command-list"
      itemIdPrefix="command"
      emptyMessage={showLoadError ? LOAD_ERROR_TITLE : "No commands available"}
      emptyContent={showLoadError ? loadErrorContent : <EmptyHint />}
      // A query typed while the list was loading must not turn the failure
      // into "No matches": nothing was searched.
      noMatchMessage={showLoadError ? LOAD_ERROR_TITLE : undefined}
      noMatchContent={showLoadError ? loadErrorContent : undefined}
      footer={
        showLoadError ? (
          <PaletteFooterHints primaryHint={{ keys: ["↵"], label: "to retry" }} />
        ) : undefined
      }
    />
  );
}
