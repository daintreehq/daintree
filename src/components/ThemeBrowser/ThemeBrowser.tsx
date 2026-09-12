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
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Button } from "@/components/ui/button";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import type { AppColorScheme, AppThemeValidationWarning } from "@shared/types/appTheme";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useOverlayClaim, useImageError } from "@/hooks";

const PANEL_WIDTH = 380;
const LISTBOX_ID = "theme-browser-listbox";
const PREVIEW_HINT_ID = "theme-browser-preview-hint";
const EMPTY_WARNINGS: AppThemeValidationWarning[] = [];

// Sample a live row to measure row height, then divide viewport height.
// Fall back to 10 when sizes aren't measurable yet (initial layout, jsdom).
const PAGE_SIZE_FALLBACK = 10;
function computeListPageSize(
  container: HTMLElement | null,
  sampleItem: HTMLElement | null
): number {
  if (!container || !sampleItem) return PAGE_SIZE_FALLBACK;
  const viewportHeight = container.clientHeight;
  if (viewportHeight <= 0) return PAGE_SIZE_FALLBACK;
  const sampleHeight = sampleItem.getBoundingClientRect().height;
  if (sampleHeight <= 0) return PAGE_SIZE_FALLBACK;
  return Math.max(1, Math.floor(viewportHeight / sampleHeight));
}

/** Stable DOM id for a row, so the combobox can point at it. */
function rowDomId(schemeId: string): string {
  return `theme-option-${schemeId}`;
}

function ThemeRow({
  scheme,
  effectiveScheme,
  isCommitted,
  isActive,
  onSelect,
  warnings,
  onRowRef,
}: {
  scheme: AppColorScheme;
  effectiveScheme: AppColorScheme;
  isCommitted: boolean;
  isActive: boolean;
  onSelect: (id: string) => void;
  warnings: AppThemeValidationWarning[];
  onRowRef: (id: string, el: HTMLDivElement | null) => void;
}) {
  const { imgRef, error, onError } = useImageError(
    scheme.heroImage?.replace("/themes/", "/themes/thumb/")
  );
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      onRowRef(scheme.id, el);
    },
    [onRowRef, scheme.id]
  );

  return (
    <div
      ref={rowRef}
      id={rowDomId(scheme.id)}
      role="option"
      // Two separate facts, two separate attributes — matching the eight other
      // palettes in the app and the shared row CSS (ui/paletteRowStyles.ts):
      // aria-selected is the CURSOR (selection follows the active descendant,
      // per the APG combobox pattern), aria-current is what is actually SAVED.
      // Collapsing them is what makes a picker unable to say "you are running
      // this one, but you are currently trying that one".
      aria-selected={isActive}
      aria-current={isCommitted ? "true" : undefined}
      // Keep DOM focus in the filter field: these rows are not focusable, so a
      // plain click would drop focus on document.body and the next arrow key
      // would go nowhere.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onSelect(scheme.id)}
      className={cn(
        PALETTE_ROW_CLASS,
        "w-full flex items-center gap-2.5 px-2.5 py-2 text-left cursor-pointer",
        "duration-150 ease-out",
        !isActive && "hover:bg-surface-hover"
      )}
    >
      {scheme.heroImage && !error ? (
        <img
          ref={imgRef}
          src={scheme.heroImage.replace("/themes/", "/themes/thumb/")}
          alt=""
          width={80}
          height={80}
          loading="lazy"
          onError={onError}
          className="w-10 h-10 rounded-sm shrink-0 object-cover"
        />
      ) : (
        <div
          className="w-10 h-10 rounded-sm shrink-0 border border-border-default"
          style={{ backgroundColor: scheme.tokens[APP_THEME_PREVIEW_KEYS.background] }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text-primary truncate">{scheme.name}</span>
          {warnings.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-3xs text-status-warning shrink-0">
              <AlertTriangle className="h-2.5 w-2.5" />
              {warnings.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          {scheme.location && (
            <span className="text-2xs text-text-secondary truncate">{scheme.location}</span>
          )}
        </div>
      </div>
      <PaletteStrip scheme={effectiveScheme} variant="compact" />
      <div className="w-11 shrink-0 flex items-center justify-end">
        {isCommitted ? (
          <span className="inline-flex items-center gap-0.5 text-3xs font-medium text-accent-primary">
            <Check className="w-3 h-3" />
            Current
          </span>
        ) : (
          isActive && <span className="text-3xs text-text-secondary">Trying</span>
        )}
      </div>
    </div>
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

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const commitButtonRef = useRef<HTMLButtonElement>(null);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAnnouncementTimer = useCallback(() => {
    if (announceTimerRef.current) {
      clearTimeout(announceTimerRef.current);
      announceTimerRef.current = null;
    }
  }, []);

  const clearPendingAnnouncement = useCallback(() => {
    clearAnnouncementTimer();
    setPreviewAnnouncement("");
  }, [clearAnnouncementTimer]);

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

  const {
    imgRef: heroImgRef,
    error: heroError,
    onError: onHeroError,
  } = useImageError(activeScheme.heroImage);

  const lowerQuery = query.toLowerCase();
  const filteredThemes = useMemo(() => {
    const byType = typeFilter === "light" ? lightSchemes : darkSchemes;
    if (!lowerQuery) return byType;
    return byType.filter((s) => s.name.toLowerCase().includes(lowerQuery));
  }, [darkSchemes, lightSchemes, typeFilter, lowerQuery]);

  // The palette the app will ACTUALLY apply, override included. Swatches and
  // warnings both read from this — showing a theme's built-in accent next to a
  // warning computed from the overridden one would contradict itself.
  const effectiveSchemes = useMemo(
    () =>
      new Map(allSchemes.map((s) => [s.id, applyAccentOverrideToScheme(s, accentColorOverride)])),
    [allSchemes, accentColorOverride]
  );

  const warningsByScheme = useMemo(
    () => new Map([...effectiveSchemes].map(([id, scheme]) => [id, getAppThemeWarnings(scheme)])),
    [effectiveSchemes]
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
      injectSchemeToDOM(committed, { immediate: true });
    }
    clearPendingAnnouncement();
  }, [setPreviewSchemeId, clearPendingAnnouncement]);

  const handlePreview = useCallback(
    (id: string, debounceAnnounce?: boolean) => {
      const state = useAppThemeStore.getState();
      if (state.previewSchemeId === id) return;
      if (state.previewSchemeId === null && state.selectedSchemeId === id) return;
      const scheme = resolveAppTheme(id, state.customSchemes);
      setPreviewSchemeId(id);
      injectSchemeToDOM(scheme);
      if (debounceAnnounce) {
        if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
        announceTimerRef.current = setTimeout(() => {
          setPreviewAnnouncement(`Previewing: ${scheme.name}`);
        }, 300);
      } else {
        if (announceTimerRef.current) {
          clearTimeout(announceTimerRef.current);
          announceTimerRef.current = null;
        }
        setPreviewAnnouncement(`Previewing: ${scheme.name}`);
      }
    },
    [setPreviewSchemeId]
  );

  // Clear any pending keyboard-triggered announcement when the search query
  // changes so a stale announcement from a pre-filter theme doesn't fire after
  // the user has context-switched to filtering.
  useEffect(() => {
    clearPendingAnnouncement();
  }, [query, clearPendingAnnouncement]);

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
    clearPendingAnnouncement();

    commitSchemeSelection(targetId);
    const scheme = resolveAppTheme(targetId, useAppThemeStore.getState().customSchemes);
    runThemeReveal(origin, () => injectSchemeToDOM(scheme, { immediate: true }));

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
    clearPendingAnnouncement,
  ]);

  const handleCancel = useCallback(() => {
    revertPreview();
    close();
  }, [close, revertPreview]);

  // Escape is two-stage for the whole dialog: undo the filter first, cancel
  // only once there is nothing left to undo. It lives in the escape-stack
  // callback rather than on any element, because the global dispatcher and
  // keybinding layers handle Escape at the window before a React handler on
  // the dialog ever sees it — a dialog-level onKeyDown was silently bypassed
  // whenever focus sat on the mode toggle or the footer buttons.
  const handleEscape = useCallback(() => {
    if (query !== "") {
      setQuery("");
      return;
    }
    handleCancel();
  }, [query, handleCancel]);

  useEscapeStack(true, handleEscape);

  // On unmount (browser closed via either path), guarantee any lingering
  // preview is reverted and the DOM reflects the committed scheme. This is
  // a safety net for close paths that bypass handleCancel/handleCommit.
  useEffect(() => {
    return () => {
      clearAnnouncementTimer();
      const state = useAppThemeStore.getState();
      if (state.previewSchemeId !== null) {
        const committed = resolveAppTheme(state.selectedSchemeId, state.customSchemes);
        useAppThemeStore.getState().setPreviewSchemeId(null);
        injectSchemeToDOM(committed, { immediate: true });
      }
    };
  }, [clearAnnouncementTimer]);

  // Focus into the filter on open, and hand focus back to whatever opened the
  // dialog on close (APG dialog contract). The opener is only restored if it is
  // still in the document: opening from Settings unmounts the Settings dialog,
  // and that path is already handled by useThemeBrowserSettingsBridge reopening
  // the Appearance tab — focusing a detached node would just strand the user on
  // document.body.
  useEffect(() => {
    const opener = document.activeElement;
    const rafId = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      cancelAnimationFrame(rafId);
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        opener !== document.body &&
        typeof opener.focus === "function"
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

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

  // Scroll the active option into view WITHOUT moving DOM focus. Focus stays
  // on the search input for the life of the dialog (the combobox pattern), so
  // the user can arrow to a theme and then keep typing to narrow the list.
  const revealRow = useCallback((schemeId: string) => {
    const node = rowRefs.current.get(schemeId);
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (filteredThemes.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(keyboardIndex + 1, filteredThemes.length - 1);
        setKeyboardIndex(next);
        const scheme = filteredThemes[next];
        if (scheme && scheme.id !== activeSchemeId) {
          handlePreview(scheme.id, true);
          revealRow(scheme.id);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.max(keyboardIndex - 1, 0);
        setKeyboardIndex(next);
        const scheme = filteredThemes[next];
        if (scheme && scheme.id !== activeSchemeId) {
          handlePreview(scheme.id, true);
          revealRow(scheme.id);
        }
      } else if (e.key === "PageDown") {
        e.preventDefault();
        const sampleItem = rowRefs.current.values().next().value ?? null;
        const pageSize = computeListPageSize(listRef.current, sampleItem);
        const next = Math.min(keyboardIndex + pageSize, filteredThemes.length - 1);
        if (next !== keyboardIndex) {
          setKeyboardIndex(next);
          const scheme = filteredThemes[next];
          if (scheme && scheme.id !== activeSchemeId) {
            handlePreview(scheme.id, true);
            revealRow(scheme.id);
          }
        }
      } else if (e.key === "PageUp") {
        e.preventDefault();
        const sampleItem = rowRefs.current.values().next().value ?? null;
        const pageSize = computeListPageSize(listRef.current, sampleItem);
        const next = Math.max(keyboardIndex - pageSize, 0);
        if (next !== keyboardIndex) {
          setKeyboardIndex(next);
          const scheme = filteredThemes[next];
          if (scheme && scheme.id !== activeSchemeId) {
            handlePreview(scheme.id, true);
            revealRow(scheme.id);
          }
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        void handleCommit();
      }
    },
    [filteredThemes, revealRow, handleCommit, handlePreview, keyboardIndex, activeSchemeId]
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "PageDown" ||
        e.key === "PageUp" ||
        e.key === "Enter"
      ) {
        handleListKeyDown(e as unknown as React.KeyboardEvent<HTMLDivElement>);
      }
    },
    [handleListKeyDown]
  );

  // A pointer click is a navigation event too: without this the keyboard
  // cursor stays where it was, so clicking the last row and pressing ArrowDown
  // jumps back to the second row instead of continuing from the click.
  const handleSelect = useCallback(
    (id: string) => {
      const index = filteredThemes.findIndex((s) => s.id === id);
      if (index >= 0) setKeyboardIndex(index);
      handlePreview(id);
    },
    [filteredThemes, handlePreview]
  );

  // The option the combobox points at. Only meaningful while that option is
  // actually in the filtered list — a stale id would leave screen readers
  // announcing a row the user can no longer see.
  const activeRowId = filteredThemes.some((s) => s.id === activeSchemeId)
    ? rowDomId(activeSchemeId)
    : undefined;

  const isEmpty = filteredThemes.length === 0;
  const registerRowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  return (
    <div
      className="flex flex-col h-full bg-surface-canvas border-l border-border-default shadow-2xl"
      style={{ width: PANEL_WIDTH }}
      role="dialog"
      aria-modal="true"
      aria-label="Theme browser"
      aria-describedby={PREVIEW_HINT_ID}
    >
      {/* Sticky hero */}
      <div className="relative h-[200px] shrink-0 overflow-hidden">
        {activeScheme.heroImage && !heroError ? (
          <img
            ref={heroImgRef}
            src={activeScheme.heroImage}
            alt=""
            onError={onHeroError}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            style={{
              backgroundColor: activeScheme.tokens[APP_THEME_PREVIEW_KEYS.background],
            }}
          >
            <PaletteStrip scheme={effectiveSchemes.get(activeScheme.id) ?? activeScheme} />
          </div>
        )}
        <button
          type="button"
          onClick={handleCancel}
          aria-label="Close theme browser"
          className="absolute top-2 right-2 p-1 rounded-full bg-scrim-medium text-white hover:bg-scrim-strong transition-colors duration-150 ease-out"
        >
          <X className="w-4 h-4" />
        </button>
        {/* Media-overlay caption: sits on a guaranteed-dark scrim over the hero
            image, so the white label text is intentional and stays readable on
            every theme. `text-inverse` flips dark on dark themes — not usable here. */}
        <div className="absolute bottom-0 inset-x-0 bg-scrim-strong backdrop-blur-sm px-3 py-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
            {activeScheme.name}
          </span>
          {activeScheme.location && (
            <span className="text-2xs text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
              {activeScheme.location}
            </span>
          )}
        </div>
      </div>

      {/* Search + type filter */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-default shrink-0">
        {/* The field, not the bare input, is what takes focus styling: the
            magnifier sits inside the border and the lift is the neutral
            selection-outline pair AppPaletteDialog.Input and PALETTE_ROW_CLASS
            share, so the focused field and the cursor row read as one treatment. */}
        <div
          className={cn(
            "flex items-center gap-1.5 flex-1 min-w-0 pl-2 pr-2.5 py-1.5",
            "bg-overlay-soft border border-[var(--border-overlay)] rounded-[var(--radius-md)]",
            "focus-within:border-selection-outline focus-within:ring-1 focus-within:ring-selection-outline/50"
          )}
        >
          <Search className="w-3.5 h-3.5 shrink-0 text-text-secondary pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            role="combobox"

            aria-expanded
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeRowId}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Filter themes"
            aria-label="Filter themes"
            // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the field wrapper paints the focus lift via focus-within; a second ring on the bare input is what read as unstyled
            className="flex-1 min-w-0 text-xs bg-transparent text-text-primary placeholder:text-text-placeholder focus:outline-hidden"
          />
        </div>
        <div
          aria-label="Appearance mode"
          className="flex rounded-[var(--radius-md)] border border-border-default overflow-hidden shrink-0"
        >
          <button
            type="button"
            aria-pressed={typeFilter === "dark"}
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
              "px-2.5 py-0.5 text-2xs font-medium transition-colors",
              typeFilter === "dark"
                ? "bg-overlay-selected text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Dark
          </button>
          <button
            type="button"
            aria-pressed={typeFilter === "light"}
            onClick={() => {
              if (typeFilter === "light") return;
              revertPreview();
              setTypeFilter("light");
            }}
            className={cn(
              "px-2.5 py-0.5 text-2xs font-medium transition-colors border-l border-border-default",
              typeFilter === "light"
                ? "bg-overlay-selected text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Light
          </button>
        </div>
      </div>

      {/* Scrollable theme list, sized to its content rather than to the panel.
          `shrink` (grow 0, shrink 1) keeps the list as tall as its rows when
          they fit and lets it collapse into a scroller when they don't, so the
          action bar stays next to the choices instead of being stranded at the
          bottom of a tall window. `min-h-0` is what lets a flex child actually
          scroll instead of pushing past the panel bounds. */}
      <div
        ref={listRef}
        id={LISTBOX_ID}
        role="listbox"
        aria-label="Theme list"
        tabIndex={-1}
        onKeyDown={handleListKeyDown}
        className="shrink min-h-0 overflow-y-auto"
      >
        {isEmpty ? (
          <p className="text-xs text-text-secondary text-center py-4">
            No themes match your search.
          </p>
        ) : (
          filteredThemes.map((scheme) => (
            <ThemeRow
              key={scheme.id}
              scheme={scheme}
              effectiveScheme={effectiveSchemes.get(scheme.id) ?? scheme}
              isCommitted={scheme.id === selectedSchemeId}
              isActive={scheme.id === activeSchemeId}
              onSelect={handleSelect}
              warnings={warningsByScheme.get(scheme.id) ?? EMPTY_WARNINGS}
              onRowRef={registerRowRef}
            />
          ))
        )}
      </div>

      {/* Bottom action bar (the conventional, always-visible spot for a commit
          CTA — Material 3 / Apple HIG; the close ✕ stays top-right on the hero).
          It's a non-scrolling flex child — the list above is the scroll area — so
          it isn't position:sticky; the opaque bg is a belt-and-braces guard.
          The commit button uses the high-contrast INVERSE `contrast` variant
          (near-white fill + off-black text on dark themes, near-black fill +
          off-white text on light) so it's highly visible and never restyles to
          the previewed accent. */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border-default bg-surface-canvas shrink-0">
        {/* The app behind this panel is showing a live preview and is not
            interactive. Saying so is what the scrim alone cannot do — and it
            says it without tinting or blurring the very thing being judged. */}
        <p id={PREVIEW_HINT_ID} className="flex-1 min-w-0 text-2xs text-text-secondary">
          Live preview — pick a theme, or cancel to go back
        </p>
        <Button variant="ghost" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          ref={commitButtonRef}
          variant="contrast"
          size="sm"
          onClick={() => void handleCommit()}
        >
          Set theme
        </Button>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {previewAnnouncement}
      </div>

      {/* Co-located so store-dispatched announcements reach VoiceOver while
          this aria-modal subtree holds focus (Chromium 354736464). */}
      <AccessibilityAnnouncer />
    </div>
  );
}
