import { useCallback, useEffect, useMemo } from "react";
import { Mic } from "lucide-react";
import type { RecentDictation } from "@shared/types";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { suppressPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { type PaletteId } from "@/store/paletteStore";
import {
  recentDictationText,
  useRecentDictationsStore,
  type RecentDictationVersion,
} from "@/store/recentDictationsStore";
import {
  copyRecentDictation,
  focusRecoveredComposer,
  insertRecentDictation,
} from "@/services/recentDictationRecovery";

const PALETTE_ID: PaletteId = "recent-dictations";

interface RecentDictationItem {
  id: string;
  dictation: RecentDictation;
  /** The text a pick uses by default, and the row's first line. */
  text: string;
  /** The original, as heard, searched too so a word the cleanup changed still finds it. */
  original: string;
  /** Where the session was dictated, for the second line. */
  where: string;
}

const FUSE_OPTIONS = {
  keys: ["text", "original", "where"],
  threshold: 0.4,
  ignoreLocation: true,
};

const MOD_KEY = isMac() ? "⌘" : "Ctrl";
const ALT_KEY = isMac() ? "⌥" : "Alt";

function describeTarget(target: RecentDictation["target"]): string {
  const place = [target.projectName, target.worktreeLabel].filter(Boolean).join(" / ");
  const panel = target.panelTitle?.trim();
  if (panel && place) return `${panel} · ${place}`;
  return panel || place || "A panel";
}

/** The excerpt a row shows: one line, so paragraph breaks read as spaces. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * "Recent dictations" (#14637): the app session's finished dictations, newest
 * first, from main's memory-only history. Enter appends one to the focused
 * composer's draft and Cmd/Ctrl+Enter copies it; holding Alt uses the
 * original, as heard, instead of the cleaned-up text.
 */
export function RecentDictationsPalette() {
  const dictations = useRecentDictationsStore((s) => s.dictations);

  const items = useMemo<RecentDictationItem[]>(
    () =>
      dictations.map((dictation) => ({
        id: dictation.id,
        dictation,
        text: oneLine(recentDictationText(dictation)),
        original: oneLine(dictation.rawText),
        where: describeTarget(dictation.target),
      })),
    [dictations]
  );

  const palette = useSearchablePalette<RecentDictationItem>({
    items,
    fuseOptions: FUSE_OPTIONS,
    paletteId: PALETTE_ID,
    getItemId: (item) => item.id,
  });
  const { isOpen, query, results, selectedIndex, setQuery, setSelectedIndex, close } = palette;

  useEffect(() => {
    if (isOpen) setQuery("");
  }, [isOpen, setQuery]);

  const pick = useCallback(
    (item: RecentDictationItem, copy: boolean, version: RecentDictationVersion) => {
      if (copy) {
        // Inside the gesture, so its "Copied" flash shows where it was asked for.
        copyRecentDictation(item.dictation, version);
        close();
        return;
      }
      const panelId = insertRecentDictation(item.dictation, version);
      // The keyboard goes to the composer the words went into, not back to
      // whatever opened the palette.
      if (panelId) {
        suppressPaletteFocusRestore();
        close();
        focusRecoveredComposer(panelId);
        return;
      }
      close();
    },
    [close]
  );

  const handleConfirm = useCallback(
    (copy: boolean) => {
      const item = results[selectedIndex];
      if (item) pick(item, copy, "cleaned");
    },
    [results, selectedIndex, pick]
  );

  // Alt+Enter is the same pick with the original; the palette's own Enter
  // handling only knows about the copy modifier.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" || !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const item = results[selectedIndex];
      if (item) pick(item, isMac() ? e.metaKey : e.ctrlKey, "original");
    },
    [results, selectedIndex, pick]
  );

  const getFooter = useCallback((item: RecentDictationItem | null) => {
    if (!item) return null;
    return (
      <PaletteFooterHints
        primaryHint={{ keys: ["↵"], label: "to add to draft" }}
        hints={[
          { keys: [MOD_KEY, "↵"], label: "to copy" },
          // Only where there is a second version to choose.
          ...(item.dictation.correctedText !== null
            ? [{ keys: [ALT_KEY, "↵"], label: "for the original" }]
            : []),
        ]}
      />
    );
  }, []);

  const renderItem = useCallback(
    (
      item: RecentDictationItem,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => (
      <button
        key={item.id}
        type="button"
        id={`recent-dictation-${item.id}`}
        tabIndex={-1}
        role="option"
        aria-selected={isSelected}
        onPointerDown={(e) => e.preventDefault()}
        onPointerMove={() => onHoverIndex(index)}
        onClick={(e) => {
          setSelectedIndex(index);
          pick(item, isMac() ? e.metaKey : e.ctrlKey, e.altKey ? "original" : "cleaned");
        }}
        className={cn(
          PALETTE_ROW_CLASS,
          "w-full flex items-start gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left text-text-secondary"
        )}
      >
        <Mic className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-text-primary">
              {item.text}
            </span>
            <TimeAgo
              timestamp={item.dictation.endedAt}
              className="shrink-0 text-xs text-text-secondary"
            />
          </div>
          <div className="truncate text-xs text-text-secondary">{item.where}</div>
        </div>
      </button>
    ),
    [pick, setSelectedIndex]
  );

  return (
    <SearchablePalette<RecentDictationItem>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={results}
      totalResults={palette.totalResults}
      selectedIndex={selectedIndex}
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
      label="Recent dictations"
      ariaLabel="Recent dictations"
      searchPlaceholder="Search recent dictations…"
      searchAriaLabel="Search recent dictations"
      itemIdPrefix="recent-dictation"
      emptyMessage="No dictations yet"
      emptyContent={
        <p className="mt-2 text-xs text-text-secondary">
          Dictate into an agent and it stays here until Daintree quits.
        </p>
      }
    />
  );
}
