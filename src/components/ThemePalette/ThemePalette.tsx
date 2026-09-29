import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { HighlightedText, findMatchIndices } from "@/components/ui/HighlightedText";
import { Check } from "lucide-react";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useAppThemeStore, injectSchemeToDOM } from "@/store/appThemeStore";
import { notify } from "@/lib/notify";
import { appThemeClient } from "@/clients/appThemeClient";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { resolveAppTheme } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { THEME_MODE_LABEL, searchThemes } from "./themeSearch";

const filterThemes = (items: AppColorScheme[], query: string): AppColorScheme[] =>
  searchThemes(items, query).items;

interface ThemePaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

const getThemeSectionLabel = (scheme: AppColorScheme): string => THEME_MODE_LABEL[scheme.type];

function ThemeListItem({
  scheme,
  isSelected,
  isCurrent,
  matches,
  onClick,
  onHover,
}: {
  scheme: AppColorScheme;
  isSelected: boolean;
  isCurrent: boolean;
  matches: readonly FuseResultMatch[] | undefined;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      id={`theme-option-${scheme.id}`}
      // Pointing moves the one cursor, so the pointer previews a theme exactly as
      // the arrow keys do, and the row that looks lit is the one Enter saves.
      onPointerMove={isSelected ? undefined : onHover}
      onClick={onClick}
      role="option"
      // The cursor, and only the cursor — the live preview follows it. What is
      // saved is `aria-current` with a check, so "running this, trying that"
      // is two marks rather than two competing backgrounds.
      aria-selected={isSelected}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        PALETTE_ROW_CLASS,
        "w-full text-left px-3 rounded-[var(--radius-md)] flex items-center gap-3",
        scheme.location ? "py-2" : "py-1.5"
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">
          <HighlightedText text={scheme.name} indices={findMatchIndices(matches, "name")} />
        </div>
        {scheme.location && (
          <div className="text-xs text-text-secondary truncate">
            <HighlightedText
              text={scheme.location}
              indices={findMatchIndices(matches, "location")}
            />
          </div>
        )}
      </div>
      <PaletteStrip scheme={scheme} variant="compact" />
      {/* Reserved whether or not it is filled, so the strips hold one column. */}
      <span className="flex w-4 shrink-0 justify-center">
        {isCurrent && (
          <>
            <Check className="w-4 h-4 text-text-primary" aria-hidden="true" />
            <span className="sr-only">Current theme</span>
          </>
        )}
      </span>
    </button>
  );
}

export function ThemePalette({ isOpen, onClose }: ThemePaletteProps) {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);
  const themePaletteShortcut = useEffectiveCombo("app.theme.pick");

  const allSchemes = useMemo(() => [...BUILT_IN_APP_SCHEMES, ...customSchemes], [customSchemes]);

  const {
    query,
    results,
    totalResults,
    selectedIndex,
    setQuery,
    setSelectedIndex,
    selectPrevious,
    selectNext,
  } = useSearchablePalette<AppColorScheme>({
    items: allSchemes,
    filterFn: filterThemes,
    // Every theme stays reachable by browsing: the shell's default cap of 20
    // cut imported themes off the end, including a committed one.
    maxResults: allSchemes.length,
    // Match marks are computed from the live query below, so the rows must be
    // too — a deferred pass would pair one query's rows with another's marks.
    deferFiltering: false,
    paletteId: "theme",
    getItemId: (scheme) => scheme.id,
  });
  const matchesById = useMemo(() => searchThemes(allSchemes, query).matches, [allSchemes, query]);

  const originalSchemeIdRef = useRef<string | null>(null);
  const committedRef = useRef(false);
  const wasOpenRef = useRef(false);
  // Flips false → true on the first live-preview run of an open cycle so we can
  // skip the initial render's injection. Without this guard the live-preview
  // effect injects `results[0]` before the seeded `selectedIndex` has settled,
  // causing a visible "flash" to the wrong theme and, if the user hit Enter
  // without navigating, silently committing the wrong theme.
  const livePreviewReadyRef = useRef(false);

  // Capture original theme on open; revert on close if not committed.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const currentSchemeId = useAppThemeStore.getState().selectedSchemeId;
      originalSchemeIdRef.current = currentSchemeId;
      committedRef.current = false;
      wasOpenRef.current = true;
      livePreviewReadyRef.current = false;
      // Reset search state: the palette is opened via paletteStore.openPalette
      // (from the daintree:open-theme-palette event), bypassing useSearchablePalette's
      // own open() which resets query + selectedIndex.
      setQuery("");
      // Seed selectedIndex to the currently active theme so the palette opens
      // on the user's current selection instead of the first built-in scheme.
      // `results` here reflects the pre-open render, which is the full list
      // (the palette was just closed, query was empty).
      const currentIdx = results.findIndex((s) => s.id === currentSchemeId);
      if (currentIdx >= 0) {
        setSelectedIndex(currentIdx);
      }
      return;
    }
    if (!isOpen && wasOpenRef.current) {
      wasOpenRef.current = false;
      livePreviewReadyRef.current = false;
      const originalId = originalSchemeIdRef.current;
      if (!committedRef.current && originalId) {
        const latestCustom = useAppThemeStore.getState().customSchemes;
        const originalScheme = resolveAppTheme(originalId, latestCustom);
        injectSchemeToDOM(originalScheme);
      }
      originalSchemeIdRef.current = null;
      committedRef.current = false;
    }
  }, [isOpen, results, setQuery, setSelectedIndex]);

  // Live preview: inject the focused scheme's CSS variables directly (no store commit).
  // Skips the first render of each open cycle so we don't flash results[0] before
  // the seeded selectedIndex has rendered.
  useEffect(() => {
    if (!isOpen) return;
    if (results.length === 0) {
      // Nothing left to try, so go back to the saved theme rather than keep
      // painting one the filter has hidden, which no row or footer could name.
      const originalId = originalSchemeIdRef.current;
      if (livePreviewReadyRef.current && originalId) {
        injectSchemeToDOM(resolveAppTheme(originalId, useAppThemeStore.getState().customSchemes));
      }
      return;
    }
    if (!livePreviewReadyRef.current) {
      livePreviewReadyRef.current = true;
      return;
    }
    if (selectedIndex < 0 || selectedIndex >= results.length) return;
    injectSchemeToDOM(results[selectedIndex]!);
  }, [isOpen, results, selectedIndex]);

  const commit = useCallback(
    (scheme: AppColorScheme) => {
      committedRef.current = true;
      setSelectedSchemeId(scheme.id);
      appThemeClient.setColorScheme(scheme.id).catch((error) => {
        logError("Failed to persist theme selection", error);
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          priority: "high",
          message: `Couldn't save theme preference — '${scheme.name}' is applied but the choice will be lost on restart.`,
          duration: 3000,
        });
      });
      onClose();
    },
    [setSelectedSchemeId, onClose]
  );

  const savedScheme = useMemo(
    () => allSchemes.find((s) => s.id === selectedSchemeId) ?? null,
    [allSchemes, selectedSchemeId]
  );

  // Two facts, because once the cursor leaves the saved theme they differ:
  // what Enter will do, and what Escape goes back to. The saved row's check
  // can be scrolled or filtered out of view; the footer can't.
  const getThemeFooter = useCallback(
    (scheme: AppColorScheme | null) => {
      if (!scheme) return null;
      const onSaved = scheme.id === savedScheme?.id;
      return (
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <PaletteFooterHints
              primaryHint={{
                keys: ["↵"],
                label: onSaved ? `to keep ${scheme.name}` : `to apply ${scheme.name}`,
              }}
            />
          </div>
          {!onSaved && savedScheme && (
            <span className="min-w-0 max-w-[40%] truncate text-text-secondary">
              Current: {savedScheme.name}
            </span>
          )}
        </div>
      );
    },
    [savedScheme]
  );

  const handleConfirm = useCallback(() => {
    if (results.length === 0 || selectedIndex < 0 || selectedIndex >= results.length) {
      onClose();
      return;
    }
    commit(results[selectedIndex]!);
  }, [results, selectedIndex, commit, onClose]);

  return (
    <SearchablePalette<AppColorScheme>
      tier="command"
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={handleConfirm}
      onClose={onClose}
      onSelectIndex={setSelectedIndex}
      onHoverIndex={setSelectedIndex}
      getItemId={(scheme) => scheme.id}
      getFooter={getThemeFooter}
      getSectionLabel={getThemeSectionLabel}
      matchesById={matchesById}
      renderItem={(scheme, index, isSelected, onHover, matches) => (
        <ThemeListItem
          key={scheme.id}
          scheme={scheme}
          isSelected={isSelected}
          isCurrent={scheme.id === selectedSchemeId}
          matches={matches}
          onClick={() => commit(scheme)}
          onHover={() => onHover(index)}
        />
      )}
      label="Theme switcher"
      shortcut={themePaletteShortcut}
      ariaLabel="Theme palette"
      searchPlaceholder="Search themes"
      searchAriaLabel="Search themes"
      listId="theme-palette-list"
      itemIdPrefix="theme-option"
      emptyMessage="No themes available"
      totalResults={totalResults}
    />
  );
}
