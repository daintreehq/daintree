import { useState, useMemo, useEffect, useCallback, useDeferredValue } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { paletteSummary } from "@/lib/paletteSummary";
import type { CommandManifestEntry, CommandCategory } from "@shared/types/commands";

interface CommandPickerProps {
  isOpen: boolean;
  commands: CommandManifestEntry[];
  isLoading?: boolean;
  onSelect: (command: CommandManifestEntry) => void;
  onDismiss: () => void;
  filter?: CommandCategory[];
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

function firstEnabledIndex(commands: CommandManifestEntry[]): number {
  const index = commands.findIndex((cmd) => cmd.enabled);
  return index === -1 ? 0 : index;
}

function EmptyHint() {
  return (
    <p className="mt-2 text-xs text-text-secondary">
      Press <kbd className={KBD_CLASS}>Esc</kbd> to go back to the composer
    </p>
  );
}

export function CommandPicker({
  isOpen,
  commands,
  isLoading = false,
  onSelect,
  onDismiss,
  filter,
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

  // Browsing reads by category; a search reads by relevance. Category bands
  // stay only while nothing is typed — ranked results under bands would put the
  // best match wherever its category happened to sort, not first under Enter.
  const { flatCommands, categoryStarts } = useMemo(() => {
    const starts = new Map<string, CommandCategory>();
    if (trimmedQuery) {
      const ranked = available
        .map((cmd, order) => ({ cmd, order, score: scoreCommand(cmd, trimmedQuery) }))
        .filter(
          (r): r is { cmd: CommandManifestEntry; order: number; score: number } => r.score !== null
        )
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .map((r) => r.cmd);
      return { flatCommands: ranked, categoryStarts: starts };
    }

    const flat: CommandManifestEntry[] = [];
    for (const category of CATEGORY_ORDER) {
      const inCategory = available.filter((cmd) => cmd.category === category);
      if (inCategory.length === 0) continue;
      starts.set(inCategory[0]!.id, category);
      flat.push(...inCategory);
    }
    return { flatCommands: flat, categoryStarts: starts };
  }, [available, trimmedQuery]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
    }
  }, [isOpen]);

  // Unavailable rows stay in the arrow-key path so their reason can be reached
  // and read, but the highlight starts on the first command Enter can run.
  useEffect(() => {
    setSelectedIndex(firstEnabledIndex(flatCommands));
  }, [flatCommands, isOpen]);

  const handleSelectPrevious = useCallback(() => {
    setSelectedIndex((prev) =>
      flatCommands.length === 0 ? 0 : (prev - 1 + flatCommands.length) % flatCommands.length
    );
  }, [flatCommands]);

  const handleSelectNext = useCallback(() => {
    setSelectedIndex((prev) => (flatCommands.length === 0 ? 0 : (prev + 1) % flatCommands.length));
  }, [flatCommands]);

  const activate = useCallback(
    (cmd: CommandManifestEntry | undefined) => {
      // While the deferred filter is catching up, results may not match the input.
      // No-op and wait for the next render; a repeat Enter lands on the right item.
      if (isStale || !cmd?.enabled) return;
      onSelect(cmd);
    },
    [isStale, onSelect]
  );

  const handleConfirm = useCallback(() => {
    activate(flatCommands[selectedIndex]);
  }, [activate, flatCommands, selectedIndex]);

  const setSize = flatCommands.length;

  return (
    <SearchablePalette<CommandManifestEntry>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={flatCommands}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={handleSelectPrevious}
      onSelectNext={handleSelectNext}
      onConfirm={handleConfirm}
      onClose={onDismiss}
      onHoverIndex={setSelectedIndex}
      getItemId={(cmd) => cmd.id}
      getActionLabel={getCommandActionLabel}
      isLoading={isLoading}
      isFiltering={isStale}
      renderItem={(cmd, index, isSelected, onHoverIndex) => {
        const category = categoryStarts.get(cmd.id);
        const titleId = `command-${cmd.id}-title`;
        const summaryId = `command-${cmd.id}-summary`;
        const reasonId = `command-${cmd.id}-reason`;
        const reason = !cmd.enabled ? cmd.disabledReason : undefined;
        return (
          <div key={cmd.id}>
            {category && (
              // A band label, not a row: listbox children must be options, and
              // role="group" loses its label under Chromium + VoiceOver, so it
              // stands as an inert option that the arrow keys never reach
              // (it is not in `results`). Same shape as the action palette.
              <div
                role="option"
                aria-disabled="true"
                aria-selected="false"
                aria-label={CATEGORY_LABELS[category]}
                className={cn(PALETTE_SECTION_LABEL_CLASS, "px-3 pb-1 pt-1", index > 0 && "mt-2")}
              >
                {CATEGORY_LABELS[category]}
              </div>
            )}
            <div
              id={`command-${cmd.id}`}
              data-command-id={cmd.id}
              role="option"
              aria-selected={isSelected}
              aria-disabled={!cmd.enabled}
              aria-posinset={index + 1}
              aria-setsize={setSize}
              aria-labelledby={titleId}
              aria-describedby={reason ? `${summaryId} ${reasonId}` : summaryId}
              aria-haspopup={cmd.hasBuilder && cmd.enabled ? "dialog" : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onPointerMove={() => onHoverIndex(index)}
              onClick={() => activate(cmd)}
              className={cn(
                PALETTE_ROW_CLASS,
                "flex w-full flex-col gap-0.5 px-3 py-2 rounded-[var(--radius-md)] text-left text-text-secondary",
                cmd.enabled ? "cursor-pointer hover:bg-overlay-subtle" : "cursor-not-allowed"
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
                  /{cmd.id}
                </span>
                {/* Only where it is true: an unavailable row opens nothing. */}
                {cmd.hasBuilder && cmd.enabled && (
                  <span
                    aria-hidden="true"
                    className="shrink-0 rounded-[var(--radius-sm)] bg-overlay-medium px-1.5 py-px text-3xs text-text-secondary"
                  >
                    Opens form
                  </span>
                )}
              </div>
              <div id={summaryId} className="truncate text-xs text-text-secondary">
                {paletteSummary(cmd.description)}
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
      listId="command-list"
      itemIdPrefix="command"
      emptyMessage="No commands available"
      emptyContent={<EmptyHint />}
    />
  );
}
