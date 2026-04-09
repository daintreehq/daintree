import { useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useAppThemeStore, injectSchemeToDOM } from "@/store/appThemeStore";
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
        "w-full text-left px-3 py-2 rounded-[var(--radius-md)] border flex items-center gap-3 transition-colors",
        "border-canopy-border/40 hover:border-canopy-border/60 hover:bg-surface",
        isSelected && "border-canopy-accent/60 bg-canopy-accent/10"
      )}
    >
      <PaletteStrip scheme={scheme} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-canopy-text truncate">{scheme.name}</div>
        {scheme.location && (
          <div className="text-[11px] text-canopy-text/50 truncate">{scheme.location}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-canopy-text/40">
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

  const { query, results, totalResults, selectedIndex, setQuery, selectPrevious, selectNext } =
    useSearchablePalette<AppColorScheme>({
      items: allSchemes,
      fuseOptions: { keys: ["name"], threshold: 0.4 },
      paletteId: "theme",
      getItemId: (scheme) => scheme.id,
    });

  const originalSchemeIdRef = useRef<string | null>(null);
  const committedRef = useRef(false);
  const wasOpenRef = useRef(false);

  // Capture original theme on open; revert on close if not committed.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      originalSchemeIdRef.current = useAppThemeStore.getState().selectedSchemeId;
      committedRef.current = false;
      wasOpenRef.current = true;
      return;
    }
    if (!isOpen && wasOpenRef.current) {
      wasOpenRef.current = false;
      const originalId = originalSchemeIdRef.current;
      if (!committedRef.current && originalId) {
        const latestCustom = useAppThemeStore.getState().customSchemes;
        const originalScheme = resolveAppTheme(originalId, latestCustom);
        injectSchemeToDOM(originalScheme);
      }
      originalSchemeIdRef.current = null;
      committedRef.current = false;
    }
  }, [isOpen]);

  // Live preview: inject the focused scheme's CSS variables directly (no store commit).
  useEffect(() => {
    if (!isOpen) return;
    if (results.length === 0) return;
    if (selectedIndex < 0 || selectedIndex >= results.length) return;
    injectSchemeToDOM(results[selectedIndex]);
  }, [isOpen, results, selectedIndex]);

  const commit = useCallback(
    (scheme: AppColorScheme) => {
      committedRef.current = true;
      setSelectedSchemeId(scheme.id);
      appThemeClient.setColorScheme(scheme.id).catch((error) => {
        console.error("Failed to persist theme selection:", error);
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
    commit(results[selectedIndex]);
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

export default ThemePalette;
