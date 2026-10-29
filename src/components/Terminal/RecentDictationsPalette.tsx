import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { TriangleAlert } from "@/components/icons";
import { MAX_RECENT_DICTATIONS, type RecentDictation } from "@shared/types";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { describeKeyCap } from "@/lib/kbdShortcut";
import { pluralize } from "@/lib/pluralize";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useSearchablePalette, type FuseResultMatch } from "@/hooks/useSearchablePalette";
import { useRecentDictationDestination } from "@/hooks/useRecentDictationDestination";
import { type PaletteId } from "@/store/paletteStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  recentDictationText,
  useRecentDictationsStore,
  type RecentDictationVersion,
} from "@/store/recentDictationsStore";
import {
  copyRecentDictation,
  focusRecoveredComposer,
  insertRecentDictation,
  type RecentDictationDestination,
} from "@/services/recentDictationRecovery";
import { excerptPreview, findPreviewMatches, type MatchRange } from "@/utils/promptHistoryPreview";

const PALETTE_ID: PaletteId = "recent-dictations";
const PREVIEW_ID = "recent-dictation-preview";
const PREVIEW_HINT_ID = "recent-dictation-preview-hint";

interface RecentDictationItem {
  id: string;
  dictation: RecentDictation;
  /** The text a plain pick uses, on one line: the row's first line. */
  text: string;
  /** Where each of `text`'s characters sits in the full text, for marking a match in the preview. */
  textOffsets: number[];
  /** The original, as heard, on one line — only where cleanup changed it, so it's searched once. */
  original: string;
  originalOffsets: number[];
  /** The panel the session dictated into, for the second line. */
  panel: string;
  /** Its project and worktree. */
  place: string;
  /** `panel · place`, searched as one string. */
  where: string;
}

const FUSE_OPTIONS = {
  keys: ["text", "original", "where"],
  // The sibling prompt-history palette's tolerance: one slip in a short word
  // ("parsr") still finds it, where 0.4 matched scattered letters across
  // every long dictation in the list.
  threshold: 0.3,
  minMatchCharLength: 2,
  ignoreLocation: true,
};

const MOD_KEY = isMac() ? "⌘" : "Ctrl";
const ALT_KEY = isMac() ? "⌥" : "Alt";

/** How many characters fit before the list column's ellipsis, for anchoring an excerpt on its match. */
const ROW_EXCERPT = { visibleChars: 34, leadChars: 12 };
/** The same for each half of the source line, which shares its width with the version tag. */
const SOURCE_EXCERPT = { visibleChars: 16, leadChars: 6 };

/** The list column beside the preview; the results take the full width when there's nothing to preview. */
const LIST_COLUMN_CLASS = "w-[25rem] shrink-0 max-[900px]:w-full max-[900px]:max-h-[30vh]";

function describeSource(target: RecentDictation["target"]): { panel: string; place: string } {
  return {
    panel: target.panelTitle?.trim() || "Untitled panel",
    place: [target.projectName, target.worktreeLabel].filter(Boolean).join(" / "),
  };
}

/**
 * The text on one line, so a row's excerpt reads paragraph breaks as spaces,
 * with each kept character's offset in the full text: search runs over the
 * line, and its ranges are marked in the preview's verbatim text through these.
 */
function collapse(text: string): { line: string; offsets: number[] } {
  let line = "";
  const offsets: number[] = [];
  let gap = -1;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) {
      if (line && gap < 0) gap = i;
      continue;
    }
    if (gap >= 0) {
      line += " ";
      offsets.push(gap);
      gap = -1;
    }
    line += text[i];
    offsets.push(i);
  }
  return { line, offsets };
}

function toVerbatim(ranges: MatchRange[] | undefined, offsets: number[]): MatchRange[] | undefined {
  return ranges?.map(([start, end]): MatchRange => [offsets[start]!, offsets[end]!]);
}

function attemptKey(item: RecentDictationItem, query: string, reason: string): string {
  return `${item.id}\u0000${query}\u0000${reason}`;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function fuzzyRanges(
  matches: readonly FuseResultMatch[] | undefined,
  key: string
): readonly MatchRange[] | undefined {
  return matches?.find((m) => m.key === key)?.indices;
}

/**
 * Where a query shows on a dictation's three strings, or nothing while
 * browsing. One answer for the row and the preview, so the two never
 * disagree about why something matched.
 */
interface RowMatches {
  text?: MatchRange[];
  original?: MatchRange[];
  where?: MatchRange[];
}

function rowMatches(
  item: RecentDictationItem,
  query: string,
  matches: readonly FuseResultMatch[] | undefined
): RowMatches {
  const q = query.trim();
  if (!q) return {};
  // The words as typed win: "parsr" is literally in the original, and the
  // cleaned text's fuzzy hit on "parser" is not the reason worth showing.
  // Only a query no string holds literally (a typo) falls back to the
  // scorer's ranges.
  const literal: RowMatches = {
    text: findPreviewMatches(item.text, q, undefined),
    original: item.original ? findPreviewMatches(item.original, q, undefined) : undefined,
    where: findPreviewMatches(item.where, q, undefined),
  };
  if (literal.text || literal.original || literal.where) return literal;
  const fuzzy: RowMatches = {
    text: findPreviewMatches(item.text, q, fuzzyRanges(matches, "text")),
    original: item.original
      ? findPreviewMatches(item.original, q, fuzzyRanges(matches, "original"))
      : undefined,
    where: findPreviewMatches(item.where, q, fuzzyRanges(matches, "where")),
  };
  if (fuzzy.text || fuzzy.original || fuzzy.where) return fuzzy;
  return nearestWord(item, matches) ?? {};
}

/**
 * The word holding the scorer's longest run, for a typo whose runs are all
 * too short to mark on their own ("tezt" keeps only "te" of "test"): every
 * row the search returns still says why it's there.
 */
function nearestWord(
  item: RecentDictationItem,
  matches: readonly FuseResultMatch[] | undefined
): RowMatches | null {
  let best: { key: keyof RowMatches; range: MatchRange } | null = null;
  for (const key of ["text", "original", "where"] as const) {
    for (const range of fuzzyRanges(matches, key) ?? []) {
      if (!best || range[1] - range[0] > best.range[1] - best.range[0]) best = { key, range };
    }
  }
  if (!best) return null;
  const text = item[best.key];
  let [start, end] = best.range;
  while (start > 0 && /\S/.test(text[start - 1]!)) start--;
  while (end < text.length - 1 && /\S/.test(text[end + 1]!)) end++;
  const word: RowMatches = {};
  word[best.key] = [[start, end]];
  return word;
}

/**
 * The keys for an action, drawn the way the footer's hints draw them so a
 * chord reads the same in both places; spoken by name, not by glyph.
 */
function KeyCaps({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className="sr-only">{keys.map((key) => describeKeyCap(key, isMac())).join(" ")}</span>
      {keys.map((key) => (
        <kbd key={key} aria-hidden="true" className={KBD_CLASS}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

interface RecentDictationRowProps {
  item: RecentDictationItem;
  index: number;
  isSelected: boolean;
  query: string;
  matches: readonly FuseResultMatch[] | undefined;
  onPick: (item: RecentDictationItem, copy: boolean, version: RecentDictationVersion) => void;
  onHoverIndex: (index: number) => void;
}

function RecentDictationRow({
  item,
  index,
  isSelected,
  query,
  matches,
  onPick,
  onHoverIndex,
}: RecentDictationRowProps) {
  const found = rowMatches(item, query, matches);
  const excerpt = excerptPreview(item.text, found.text, ROW_EXCERPT);
  // A word only the original has: the second line shows where it is in the
  // original, so the row says why it matched instead of looking like noise.
  const originalOnly = !found.text && !found.where && found.original;
  const originalExcerpt = originalOnly
    ? excerptPreview(item.original, found.original, ROW_EXCERPT)
    : null;
  const whereRanges = found.where;
  const placeOffset = item.panel.length + 3;
  // Each half anchored on its own match, so a hit late in a long title or
  // branch isn't marked somewhere past the ellipsis.
  const panel = excerptPreview(
    item.panel,
    whereRanges?.filter(([s]) => s < item.panel.length),
    SOURCE_EXCERPT
  );
  const place = excerptPreview(
    item.place,
    whereRanges
      ?.filter(([s]) => s >= placeOffset)
      .map(([s, e]): MatchRange => [s - placeOffset, e - placeOffset]),
    SOURCE_EXCERPT
  );
  const hasOriginal = item.dictation.correctedText !== null;

  return (
    <button
      type="button"
      id={`recent-dictation-${item.id}`}
      tabIndex={-1}
      role="option"
      aria-selected={isSelected}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={() => onHoverIndex(index)}
      onClick={(e) =>
        onPick(item, isMac() ? e.metaKey : e.ctrlKey, e.altKey ? "original" : "cleaned")
      }
      className={cn(
        PALETTE_ROW_CLASS,
        "w-full flex items-start gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left text-text-secondary"
      )}
    >
      <Mic className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-3">
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-text-primary">
            <HighlightedText text={excerpt.text} indices={excerpt.indices} />
          </span>
          <TimeAgo
            timestamp={item.dictation.endedAt}
            className="shrink-0 text-xs text-text-secondary tabular-nums"
          />
        </span>
        <span className="mt-0.5 flex items-baseline gap-2 text-xs text-text-secondary">
          {originalExcerpt ? (
            <span className="flex-1 min-w-0 truncate">
              In original:{" "}
              <HighlightedText text={originalExcerpt.text} indices={originalExcerpt.indices} />
            </span>
          ) : (
            <span className="flex flex-1 min-w-0 items-baseline">
              {/* The title gives way first but never takes the whole line:
                  the project and worktree are what tell two Claudes apart. */}
              <span className="min-w-0 max-w-[60%] shrink-0 truncate">
                <HighlightedText text={panel.text} indices={panel.indices} />
              </span>
              {item.place && (
                <>
                  <span aria-hidden="true" className="shrink-0 px-1">
                    ·
                  </span>
                  <span className="min-w-0 truncate">
                    <HighlightedText text={place.text} indices={place.indices} />
                  </span>
                </>
              )}
            </span>
          )}
          {/* Only where there are two versions: a single-version row is as heard. */}
          {hasOriginal && <span className="shrink-0">Cleaned + original</span>}
        </span>
      </span>
    </button>
  );
}

interface VersionSectionProps {
  label: string;
  text: string;
  ranges: MatchRange[] | undefined;
  /** The keys that add and copy this version from the search field. */
  addKeys: string[];
  copyKeys: string[];
  canAdd: boolean;
  onAdd: () => void;
  onCopy: () => void;
  sectionRef?: React.Ref<HTMLElement>;
  secondary?: boolean;
}

const VERSION_ACTION_CLASS = cn(
  "inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 text-2xs text-text-secondary",
  "transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-text-primary",
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary",
  // The button primitive's unavailable treatment. Still pressable: a press
  // says why, where the footer already does.
  "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-secondary"
);

// Sized to the original's "Add ⌥ ↵" and "Copy ⌥ ⌘ ↵" (79px and 111px on
// macOS), with Alt and Ctrl spelled out on the other platforms.
const ADD_COLUMN_CLASS = isMac() ? "w-[5.25rem]" : "w-[6.5rem]";
const COPY_COLUMN_CLASS = isMac() ? "w-[7.25rem]" : "w-[9.75rem]";

function VersionSection({
  label,
  text,
  ranges,
  addKeys,
  copyKeys,
  canAdd,
  onAdd,
  onCopy,
  sectionRef,
  secondary = false,
}: VersionSectionProps) {
  return (
    <section ref={sectionRef} aria-label={label} className="not-first:mt-4">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className={PALETTE_SECTION_LABEL_CLASS}>{label}</h3>
        {/* Pointer routes to the same picks the chords make. A press here
            keeps the keyboard in the search field, where the chords live. */}
        {/* Label before keys, in columns as wide as the longest chord, so the
            two versions' Add and Copy stand one above the other. */}
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            tabIndex={-1}
            aria-disabled={canAdd ? undefined : "true"}
            onPointerDown={(e) => e.preventDefault()}
            onClick={onAdd}
            className={cn(VERSION_ACTION_CLASS, ADD_COLUMN_CLASS)}
          >
            Add
            <KeyCaps keys={addKeys} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => e.preventDefault()}
            onClick={onCopy}
            className={cn(VERSION_ACTION_CLASS, COPY_COLUMN_CLASS)}
          >
            Copy
            <KeyCaps keys={copyKeys} />
          </button>
        </span>
      </div>
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-sm leading-relaxed",
          secondary ? "text-text-secondary" : "text-text-primary"
        )}
      >
        <HighlightedText text={text} indices={ranges} />
      </p>
    </section>
  );
}

interface RecentDictationPreviewProps {
  item: RecentDictationItem;
  query: string;
  matches: readonly FuseResultMatch[] | undefined;
  destination: RecentDictationDestination;
  onPick: (item: RecentDictationItem, copy: boolean, version: RecentDictationVersion) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

function RecentDictationPreview({
  item,
  query,
  matches,
  destination,
  onPick,
  scrollRef,
}: RecentDictationPreviewProps) {
  const { dictation } = item;
  const hasOriginal = dictation.correctedText !== null;
  const cleaned = recentDictationText(dictation);
  const q = query.trim();
  const found = rowMatches(item, query, matches);
  const originalRef = useRef<HTMLElement>(null);

  // A new selection starts at the top, unless the reason it matched is only
  // in the original, which may sit below a long cleaned version.
  const matchOnlyInOriginal = !found.text && found.original !== undefined;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const original = originalRef.current;
    scroller.scrollTop =
      matchOnlyInOriginal && original ? original.offsetTop - scroller.offsetTop - 12 : 0;
  }, [item.id, q, matchOnlyInOriginal, scrollRef]);

  const words = wordCount(dictation.rawText);

  return (
    <div
      id={PREVIEW_ID}
      role="region"
      aria-label="Selected dictation"
      className={cn(
        "flex min-w-0 flex-1 flex-col border-l border-border-strong",
        "max-[900px]:border-l-0 max-[900px]:border-t"
      )}
    >
      <ScrollShadow
        ref={scrollRef}
        className="max-h-[60vh] flex-1 max-[900px]:max-h-[34vh]"
        scrollClassName="px-4 py-3"
      >
        {/* One child, so the scroll fade follows the text's height as the selection changes. */}
        <div>
          <dl className="mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-text-secondary">Dictated in</dt>
            <dd className="min-w-0 break-words text-text-primary">
              <HighlightedText text={item.where} indices={found.where} />
            </dd>
            <dt className="text-text-secondary">Finished</dt>
            <dd className="text-text-primary">
              <TimeAgo timestamp={dictation.endedAt} /> · {pluralize(words, "word")}
            </dd>
          </dl>
          <VersionSection
            label={hasOriginal ? "Cleaned up" : "As heard"}
            text={cleaned}
            ranges={toVerbatim(found.text, item.textOffsets)}
            addKeys={["↵"]}
            copyKeys={[MOD_KEY, "↵"]}
            canAdd={destination.ok}
            onAdd={() => onPick(item, false, "cleaned")}
            onCopy={() => onPick(item, true, "cleaned")}
          />
          {hasOriginal && (
            <VersionSection
              sectionRef={originalRef}
              label="Original, as heard"
              text={dictation.rawText}
              ranges={toVerbatim(found.original, item.originalOffsets)}
              addKeys={[ALT_KEY, "↵"]}
              copyKeys={[ALT_KEY, MOD_KEY, "↵"]}
              canAdd={destination.ok}
              onAdd={() => onPick(item, false, "original")}
              onCopy={() => onPick(item, true, "original")}
              secondary
            />
          )}
        </div>
      </ScrollShadow>
    </div>
  );
}

/**
 * "Recent dictations" (#14637, #15127): the app session's finished
 * dictations, newest first, from main's memory-only history, with the
 * selected one in full beside the list. Enter appends it to the draft the
 * footer names and Cmd/Ctrl+Enter copies it; holding Alt uses the original,
 * as heard, instead of the cleaned-up text. Where the add can't happen the
 * footer says why before Enter, and Enter leaves the palette and the search
 * as they were.
 */
export function RecentDictationsPalette() {
  const dictations = useRecentDictationsStore((s) => s.dictations);
  const previewScrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo<RecentDictationItem[]>(
    () =>
      dictations.map((dictation) => {
        const { panel, place } = describeSource(dictation.target);
        const text = collapse(recentDictationText(dictation));
        const original =
          dictation.correctedText !== null
            ? collapse(dictation.rawText)
            : { line: "", offsets: [] };
        return {
          id: dictation.id,
          dictation,
          text: text.line,
          textOffsets: text.offsets,
          original: original.line,
          originalOffsets: original.offsets,
          panel,
          place,
          where: place ? `${panel} · ${place}` : panel,
        };
      }),
    [dictations]
  );

  const palette = useSearchablePalette<RecentDictationItem>({
    items,
    fuseOptions: FUSE_OPTIONS,
    includeMatches: true,
    paletteId: PALETTE_ID,
    getItemId: (item) => item.id,
  });
  const { isOpen, query, results, selectedIndex, setQuery, setSelectedIndex, close } = palette;
  const destination = useRecentDictationDestination(isOpen);
  // The add Enter just refused, so the footer can say it didn't happen
  // rather than repeat what it said before the press. Keyed on what was
  // tried, so a new selection, query or destination reads fresh.
  const [refusedAttempt, setRefusedAttempt] = useState<string | null>(null);
  // Cleared, not just hidden, once its moment passes: coming back to the row
  // later must not show a refusal nobody just asked for.
  const selectedId = results[selectedIndex]?.id ?? null;
  const destinationKey = destination.ok ? destination.label : destination.reason;
  useEffect(() => {
    setRefusedAttempt(null);
  }, [isOpen, selectedId, query, destinationKey]);

  useEffect(() => {
    if (isOpen) setQuery("");
  }, [isOpen, setQuery]);

  // The toolbar menu's "View full dictation…" opens the palette on that one.
  const revealId = useRecentDictationsStore((s) => s.revealId);
  useEffect(() => {
    if (!isOpen || revealId === null) return;
    const index = results.findIndex((item) => item.id === revealId);
    if (index >= 0) {
      setSelectedIndex(index);
      useRecentDictationsStore.getState().reveal(null);
    }
  }, [isOpen, revealId, results, setSelectedIndex]);

  const pick = useCallback(
    (item: RecentDictationItem, copy: boolean, version: RecentDictationVersion) => {
      if (copy) {
        // Inside the gesture, so its "Copied" flash shows where it was asked for.
        copyRecentDictation(item.dictation, version);
        close();
        return;
      }
      // Refused before it's tried: the footer already says why, so the
      // palette stays open with the search and selection as they were.
      if (!destination.ok) {
        setRefusedAttempt(attemptKey(item, query, destination.reason));
        useAnnouncerStore
          .getState()
          .announce(`Not added to draft: ${destination.reason}`, "assertive");
        return;
      }
      const panelId = insertRecentDictation(item.dictation, version);
      if (!panelId) return;
      // The keyboard goes to the composer the words went into, not back to
      // whatever opened the palette.
      suppressPaletteFocusRestore();
      close();
      focusRecoveredComposer(panelId);
    },
    [close, destination, query]
  );

  const handleConfirm = useCallback(
    (copy: boolean) => {
      const item = results[selectedIndex];
      if (item) pick(item, copy, "cleaned");
    },
    [results, selectedIndex, pick]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // The preview scrolls from the search field, which keeps the keyboard.
      if (e.key === "PageDown" || e.key === "PageUp") {
        const scroller = previewScrollRef.current;
        if (!scroller) return;
        e.preventDefault();
        const page = scroller.clientHeight * 0.85;
        scroller.scrollBy({ top: e.key === "PageDown" ? page : -page, behavior: "instant" });
        return;
      }
      // Alt+Enter is the same pick with the original; the palette's own Enter
      // handling only knows about the copy modifier.
      if (e.key !== "Enter" || !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const item = results[selectedIndex];
      if (item) pick(item, isMac() ? e.metaKey : e.ctrlKey, "original");
    },
    [results, selectedIndex, pick]
  );

  const getFooter = useCallback(
    (item: RecentDictationItem | null) => {
      if (!item) return null;
      // The footer's own hint chips, laid out here rather than through
      // PaletteFooterHints because the lead wraps instead of truncating: the
      // destination is the last check against adding to the wrong pane, and a
      // long title must not cost it its worktree, nor a reason its condition.
      const refused =
        !destination.ok && refusedAttempt === attemptKey(item, query, destination.reason);
      return (
        <div className="@container/palette-footer flex w-full min-w-0 items-baseline justify-between gap-4">
          {destination.ok ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <KeyCaps keys={["↵"]} />
              <span className="min-w-0 break-words">
                to add to draft in <span className="text-text-primary">{destination.label}</span>
              </span>
            </span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-1.5" role="status">
              {/* Out of the baseline row, so the reason's text lines up with "to copy". */}
              <TriangleAlert
                className="mt-px size-3.5 shrink-0 self-start text-status-warning"
                aria-hidden="true"
              />
              <span className="min-w-0 break-words text-text-primary">
                {refused ? "Not added to draft" : "Can't add to a draft"}: {destination.reason}
              </span>
            </span>
          )}
          {/* Copy works either way, so its hint stays until the footer is too
              narrow for it, where the shared hints drop their secondaries. */}
          <span className="flex shrink-0 items-baseline gap-1.5 @max-[380px]/palette-footer:hidden">
            <KeyCaps keys={[MOD_KEY, "↵"]} />
            to copy
          </span>
        </div>
      );
    },
    [destination, query, refusedAttempt]
  );

  const getDetail = useCallback(
    (item: RecentDictationItem | null) =>
      item ? (
        <RecentDictationPreview
          item={item}
          query={query}
          matches={palette.matchesById.get(item.id)}
          destination={destination}
          onPick={pick}
          scrollRef={previewScrollRef}
        />
      ) : null,
    [query, palette.matchesById, destination, pick]
  );

  const renderItem = useCallback(
    (
      item: RecentDictationItem,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void,
      matches: readonly FuseResultMatch[] | undefined
    ) => (
      <RecentDictationRow
        key={item.id}
        item={item}
        index={index}
        isSelected={isSelected}
        query={query}
        matches={matches}
        onPick={pick}
        onHoverIndex={onHoverIndex}
      />
    ),
    [pick, query]
  );

  return (
    <SearchablePalette<RecentDictationItem>
      tier="workspace"
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={palette.totalResults}
      selectedIndex={selectedIndex}
      matchesById={palette.matchesById}
      onQueryChange={setQuery}
      onSelectPrevious={palette.selectPrevious}
      onSelectNext={palette.selectNext}
      onConfirm={handleConfirm}
      onClose={close}
      onHoverIndex={setSelectedIndex}
      onKeyDown={handleKeyDown}
      getItemId={(item) => item.id}
      renderItem={renderItem}
      getFooter={getFooter}
      getDetail={getDetail}
      headerTrailing={
        dictations.length > 0
          ? `This session's newest ${MAX_RECENT_DICTATIONS} · cleared when Daintree quits`
          : undefined
      }
      bodyClassName={results.length > 0 ? LIST_COLUMN_CLASS : undefined}
      label="Recent dictations"
      ariaLabel="Recent dictations"
      searchPlaceholder="Search recent dictations…"
      searchAriaLabel="Search recent dictations"
      searchAriaDescribedBy={PREVIEW_HINT_ID}
      itemIdPrefix="recent-dictation"
      emptyMessage="No dictations yet"
      emptyContent={
        <p className="mt-2 text-xs text-text-secondary">
          Dictate into an agent and it stays here until Daintree quits.
        </p>
      }
      afterList={
        <span id={PREVIEW_HINT_ID} className="sr-only">
          The selected dictation is shown in full beside the list. Page Up and Page Down scroll it.
        </span>
      }
    />
  );
}
