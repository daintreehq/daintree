import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useAppThemeStore, injectSchemeToDOM } from "@/store/appThemeStore";
import { notify } from "@/lib/notify";
import { appThemeClient } from "@/clients/appThemeClient";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { resolveAppTheme } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";

interface ThemePaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

function ThemeListItem({
  scheme,
  isSelected,
  isActive,
  onClick,
}: {
  scheme: AppColorScheme;
  isSelected: boolean;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      id={`theme-option-${scheme.id}`}
      onClick={onClick}
      role="option"
      aria-selected={isSelected}
      className={cn(
        "relative w-full text-left px-3 py-2 rounded-[var(--radius-md)] border flex items-center gap-3 transition-colors",
        "border-daintree-border/40 hover:border-daintree-border/60 hover:bg-surface",
        isSelected &&
          "border-overlay bg-overlay-soft text-daintree-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
      )}
    >
      <PaletteStrip scheme={scheme} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-daintree-text truncate">{scheme.name}</div>
        {scheme.location && (
          <div className="text-[11px] text-daintree-text/50 truncate">{scheme.location}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-daintree-text/40">
          {scheme.type === "light" ? "Light" : "Dark"}
        </span>
        {isActive && (
          <span className="px-1.5 py-0.5 rounded-[var(--radius-md)] bg-[var(--color-state-active)]/15 text-[var(--color-state-active)] text-[10px] font-semibold">
            Active
          </span>
        )}
      </div>
    </button>
  );
}

export function ThemePalette({ isOpen, onClose }: ThemePaletteProps) {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  const setSelectedSchemeId = useAppThemeStore((s) => s.setSelectedSchemeId);

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
    fuseOptions: { keys: ["name"], threshold: 0.4 },
    paletteId: "theme",
    getItemId: (scheme) => scheme.id,
  });

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
    if (results.length === 0) return;
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
        notify({
          type: "error",
          priority: "high",
          message: `Failed to save theme: ${scheme.name}`,
          duration: 3000,
        });
      });
      onClose();
    },
    [setSelectedSchemeId, onClose]
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
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={selectPrevious}
      onSelectNext={selectNext}
      onConfirm={handleConfirm}
      onClose={onClose}
      getItemId={(scheme) => scheme.id}
      renderItem={(scheme, _index, isSelected) => (
        <ThemeListItem
          key={scheme.id}
          scheme={scheme}
          isSelected={isSelected}
          isActive={scheme.id === selectedSchemeId}
          onClick={() => commit(scheme)}
        />
      )}
      label="Theme switcher"
      keyHint="⌘K, T"
      ariaLabel="Theme palette"
      searchPlaceholder="Search themes..."
      searchAriaLabel="Search themes"
      listId="theme-palette-list"
      itemIdPrefix="theme-option"
      emptyMessage="No themes available"
      noMatchMessage={`No themes match "${query}"`}
      totalResults={totalResults}
    />
  );
}
