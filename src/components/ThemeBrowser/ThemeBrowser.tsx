import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { injectSchemeToDOM, useAppThemeStore } from "@/store/appThemeStore";
import { useThemeBrowserStore } from "@/store/themeBrowserStore";
import { logError } from "@/utils/logger";
import { appThemeClient } from "@/clients/appThemeClient";
import { runThemeReveal } from "@/lib/appThemeViewTransition";
import {
  APP_THEME_PREVIEW_KEYS,
  applyAccentOverrideToScheme,
  getAppThemeWarnings,
  resolveAppTheme,
} from "@shared/theme";
import { PaletteStrip } from "@/components/ui/PaletteStrip";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useOverlayClaim } from "@/hooks";

const PANEL_WIDTH = 380;

function ThemeRow({
  scheme,
  isCommitted,
  isActive,
  isKeyboardFocused,
  onSelect,
  warnings,
  rowRef,
}: {
  scheme: AppColorScheme;
  isCommitted: boolean;
  isActive: boolean;
  isKeyboardFocused: boolean;
  onSelect: (id: string) => void;
  warnings: AppThemeValidationWarning[];
  rowRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={isActive}
      tabIndex={isKeyboardFocused ? 0 : -1}
      onClick={() => onSelect(scheme.id)}
      className={cn(
        "w-full flex items-center gap-2.5 px-2.5 py-2 text-left transition-colors",
        "focus:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/60",
        isActive ? "bg-daintree-accent/10" : "hover:bg-surface-hover"
      )}
    >
      {scheme.heroImage ? (
        <img
          src={scheme.heroImage.replace("/themes/", "/themes/thumb/")}
          alt=""
          width={80}
          height={80}
          loading="lazy"
          className="w-10 h-10 rounded-sm shrink-0 object-cover"
        />
      ) : (
        <div
          className="w-10 h-10 rounded-sm shrink-0 border border-daintree-border/50"
          style={{ backgroundColor: scheme.tokens[APP_THEME_PREVIEW_KEYS.background] }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-daintree-text truncate">{scheme.name}</span>
          {warnings.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] text-status-warning shrink-0">
              <AlertTriangle className="h-2.5 w-2.5" />
              {warnings.length}
            </span>
          )}
        </div>
        {scheme.location && (
          <span className="text-[11px] text-daintree-text/40 truncate block">
            {scheme.location}
          </span>
        )}
      </div>
      <PaletteStrip scheme={scheme} />
      <div className="w-4 shrink-0 flex items-center justify-center">
        {isCommitted && <Check className="w-3.5 h-3.5 text-daintree-accent" />}
      </div>
    </button>
  );
}

export function ThemeBrowser() {
  useOverlayClaim("theme-browser", true);

  const close = useThemeBrowserStore((s) => s.close);
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  const previewSchemeId = useAppThemeStore((s) => s.previewSchemeId);
  const setPreviewSchemeId = useAppThemeStore((s) => s.setPreviewSchemeId);
  const commitSchemeSelection = useAppThemeStore((s) => s.commitSchemeSelection);
  const accentColorOverride = useAppThemeStore((s) => s.accentColorOverride);
  const followSystem = useAppThemeStore((s) => s.followSystem);
  const setFollowSystem = useAppThemeStore((s) => s.setFollowSystem);

  const [query, setQuery] = useState("");
  const [previewAnnouncement, setPreviewAnnouncement] = useState("");
  const [typeFilter, setTypeFilter] = useState<"dark" | "light">(() => {
    const committed = [...BUILT_IN_APP_SCHEMES, ...customSchemes].find(
      (s) => s.id === selectedSchemeId
    );
    return committed?.type === "light" ? "light" : "dark";
  });

  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const commitButtonRef = useRef<HTMLButtonElement>(null);

  const allSchemes = useMemo(() => [...BUILT_IN_APP_SCHEMES, ...customSchemes], [customSchemes]);
  const darkSchemes = useMemo(() => allSchemes.filter((s) => s.type !== "light"), [allSchemes]);
  const lightSchemes = useMemo(() => allSchemes.filter((s) => s.type === "light"), [allSchemes]);
  const committedScheme = useMemo(
    () => allSchemes.find((s) => s.id === selectedSchemeId) ?? allSchemes[0]!,
    [allSchemes, selectedSchemeId]
  );
  const activeSchemeId = previewSchemeId ?? selectedSchemeId;
  const activeScheme = useMemo(
    () => allSchemes.find((s) => s.id === activeSchemeId) ?? committedScheme,
    [allSchemes, activeSchemeId, committedScheme]
  );

  const lowerQuery = query.toLowerCase();
  const filteredThemes = useMemo(() => {
    const byType = typeFilter === "light" ? lightSchemes : darkSchemes;
    if (!lowerQuery) return byType;
    return byType.filter((s) => s.name.toLowerCase().includes(lowerQuery));
  }, [darkSchemes, lightSchemes, typeFilter, lowerQuery]);

  const warningsByScheme = useMemo(
    () =>
      new Map(
        allSchemes.map((scheme) => [
          scheme.id,
          getAppThemeWarnings(applyAccentOverrideToScheme(scheme, accentColorOverride)),
        ])
      ),
    [allSchemes, accentColorOverride]
  );

  const [keyboardIndex, setKeyboardIndex] = useState<number>(() => {
    const i = filteredThemes.findIndex((s) => s.id === selectedSchemeId);
    return i >= 0 ? i : 0;
  });

  // Keep keyboardIndex within bounds when the filtered list changes (e.g.,
  // on query/filter edits). Without this the roving tabindex can point at a
  // row that no longer exists.
  useEffect(() => {
    if (filteredThemes.length === 0) return;
    setKeyboardIndex((prev) => Math.min(prev, filteredThemes.length - 1));
  }, [filteredThemes.length]);

  const revertPreview = useCallback(() => {
    const state = useAppThemeStore.getState();
    if (state.previewSchemeId !== null) {
      const committed = resolveAppTheme(state.selectedSchemeId, state.customSchemes);
      setPreviewSchemeId(null);
      injectSchemeToDOM(committed);
    }
    setPreviewAnnouncement("");
  }, [setPreviewSchemeId]);

  const handlePreview = useCallback(
    (id: string) => {
      // Click = intentional preview; no debounce (distinct from the hover
      // preview in AppThemePicker which debounces at 300ms).
      const scheme = resolveAppTheme(id, useAppThemeStore.getState().customSchemes);
      setPreviewSchemeId(id);
      injectSchemeToDOM(scheme);
      setPreviewAnnouncement(`Previewing: ${scheme.name}`);
    },
    [setPreviewSchemeId]
  );

  const handleCommit = useCallback(async () => {
    const targetId = previewSchemeId ?? selectedSchemeId;
    const originRect = commitButtonRef.current?.getBoundingClientRect();
    const origin = originRect
      ? { x: originRect.left + originRect.width / 2, y: originRect.top + originRect.height / 2 }
      : null;

    if (followSystem) {
      setFollowSystem(false);
      appThemeClient
        .setFollowSystem(false)
        .catch((err) => logError("Failed to clear follow system", err));
    }

    // Clear preview state BEFORE the View Transition fires. Otherwise the
    // mutation callback would still see `previewSchemeId` in the store and
    // `injectSchemeToDOM` could be undone (see PR #5087).
    setPreviewSchemeId(null);
    setPreviewAnnouncement("");

    commitSchemeSelection(targetId);
    const scheme = resolveAppTheme(targetId, useAppThemeStore.getState().customSchemes);
    runThemeReveal(origin, () => injectSchemeToDOM(scheme));

    // Close the browser synchronously after the reveal fires — the Settings
    // reopen effect keys on this store transition, so deferring it until after
    // persistence would delay the user's return to Settings needlessly.
    close();

    try {
      await appThemeClient.setColorScheme(targetId);
      await appThemeClient.setRecentSchemeIds(useAppThemeStore.getState().recentSchemeIds);
    } catch (error) {
      logError("Failed to persist app theme", error);
    }
  }, [
    close,
    commitSchemeSelection,
    followSystem,
    previewSchemeId,
    selectedSchemeId,
    setFollowSystem,
    setPreviewSchemeId,
  ]);

  const handleCancel = useCallback(() => {
    revertPreview();
    close();
  }, [close, revertPreview]);

  useEscapeStack(true, handleCancel);

  // Scroll the committed theme into view on open so the user lands at their
  // current choice, not the top of the list. Keyboard index is already
  // initialized to the committed row via useState lazy init above — no need
  // to re-set it here. Reads from useAppThemeStore.getState() so the effect
  // has no reactive dependencies and won't re-run (and re-scroll) while the
  // user edits the search or filter.
  useLayoutEffect(() => {
    const committedId = useAppThemeStore.getState().selectedSchemeId;
    const node = rowRefs.current.get(committedId);
    // jsdom (used by unit tests) does not implement scrollIntoView; feature-detect.
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, []);

  // On unmount (browser closed via either path), guarantee any lingering
  // preview is reverted and the DOM reflects the committed scheme. This is
  // a safety net for close paths that bypass handleCancel/handleCommit.
  useEffect(() => {
    return () => {
      const state = useAppThemeStore.getState();
      if (state.previewSchemeId !== null) {
        const committed = resolveAppTheme(state.selectedSchemeId, state.customSchemes);
        useAppThemeStore.getState().setPreviewSchemeId(null);
        injectSchemeToDOM(committed);
      }
    };
  }, []);

  const focusRow = useCallback((schemeId: string) => {
    const node = rowRefs.current.get(schemeId);
    if (node) node.focus();
  }, []);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (filteredThemes.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(keyboardIndex + 1, filteredThemes.length - 1);
        setKeyboardIndex(next);
        const scheme = filteredThemes[next];
        if (scheme) {
          handlePreview(scheme.id);
          focusRow(scheme.id);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.max(keyboardIndex - 1, 0);
        setKeyboardIndex(next);
        const scheme = filteredThemes[next];
        if (scheme) {
          handlePreview(scheme.id);
          focusRow(scheme.id);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        void handleCommit();
      }
    },
    [filteredThemes, focusRow, handleCommit, handlePreview, keyboardIndex]
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape" && query !== "") {
        e.stopPropagation();
        e.preventDefault();
        setQuery("");
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
        handleListKeyDown(e as unknown as React.KeyboardEvent<HTMLDivElement>);
      }
    },
    [handleListKeyDown, query]
  );

  const isEmpty = filteredThemes.length === 0;
  const setRowRef = useCallback(
    (id: string) => (el: HTMLButtonElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    []
  );

  return (
    <div
      className="flex flex-col h-full bg-daintree-bg border-l border-daintree-border shadow-2xl"
      style={{ width: PANEL_WIDTH }}
      role="dialog"
      aria-modal="true"
      aria-label="Theme browser"
    >
      {/* Sticky hero */}
      <div className="relative h-[200px] shrink-0 overflow-hidden">
        {activeScheme.heroImage ? (
          <img
            src={activeScheme.heroImage}
            alt={activeScheme.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              backgroundColor: activeScheme.tokens[APP_THEME_PREVIEW_KEYS.background],
            }}
          >
            <PaletteStrip scheme={activeScheme} />
          </div>
        )}
        <button
          type="button"
          onClick={handleCancel}
          aria-label="Close theme browser"
          className="absolute top-2 right-2 p-1 rounded-full bg-black/40 text-white/90 hover:bg-black/60 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="absolute bottom-0 inset-x-0 bg-black/40 backdrop-blur-sm px-3 py-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
            {activeScheme.name}
          </span>
          {activeScheme.location && (
            <span className="text-[11px] text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {activeScheme.location}
            </span>
          )}
        </div>
      </div>

      {/* Search + type filter */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-daintree-border shrink-0">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 focus-within:border-daintree-accent">
          <Search className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Filter themes..."
            aria-label="Filter themes"
            className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-daintree-text/40 focus:outline-hidden"
          />
        </div>
        <div className="flex rounded-[var(--radius-md)] border border-daintree-border overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => {
              if (typeFilter === "dark") return;
              // Switching filter away from the previewed type hides the
              // previewed row from the list. Revert the preview so the hero
              // and committed state realign with what the user can actually
              // see — otherwise a hidden preview could still be committed.
              revertPreview();
              setTypeFilter("dark");
            }}
            className={cn(
              "px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              typeFilter === "dark"
                ? "bg-daintree-accent/15 text-daintree-text"
                : "text-daintree-text/50 hover:text-daintree-text/70"
            )}
          >
            Dark
          </button>
          <button
            type="button"
            onClick={() => {
              if (typeFilter === "light") return;
              revertPreview();
              setTypeFilter("light");
            }}
            className={cn(
              "px-2.5 py-0.5 text-[11px] font-medium transition-colors border-l border-daintree-border",
              typeFilter === "light"
                ? "bg-daintree-accent/15 text-daintree-text"
                : "text-daintree-text/50 hover:text-daintree-text/70"
            )}
          >
            Light
          </button>
        </div>
      </div>

      {/* Scrollable theme list. `min-h-0` is required for a flex child to
          allow `overflow-y-auto` to kick in instead of pushing the list past
          the panel bounds. */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Theme list"
        tabIndex={-1}
        onKeyDown={handleListKeyDown}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {isEmpty ? (
          <p className="text-xs text-daintree-text/50 text-center py-4">
            No themes match your search.
          </p>
        ) : (
          filteredThemes.map((scheme, index) => (
            <ThemeRow
              key={scheme.id}
              scheme={scheme}
              isCommitted={scheme.id === selectedSchemeId}
              isActive={scheme.id === activeSchemeId}
              isKeyboardFocused={index === keyboardIndex}
              onSelect={handlePreview}
              warnings={warningsByScheme.get(scheme.id) ?? []}
              rowRef={setRowRef(scheme.id)}
            />
          ))
        )}
      </div>

      {/* Sticky action bar */}
      <div className="flex items-center justify-end gap-2 px-2.5 py-2 border-t border-daintree-border shrink-0">
        <button
          type="button"
          onClick={handleCancel}
          className="px-3 py-1.5 text-xs text-daintree-text/70 hover:text-daintree-text transition-colors rounded-[var(--radius-md)]"
        >
          Cancel
        </button>
        <button
          ref={commitButtonRef}
          type="button"
          onClick={() => void handleCommit()}
          className="px-3 py-1.5 text-xs font-medium bg-daintree-accent text-white rounded-[var(--radius-md)] hover:bg-daintree-accent/90 transition-colors"
        >
          Set theme
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {previewAnnouncement}
      </div>
    </div>
  );
}
