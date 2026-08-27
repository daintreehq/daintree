import {
  Suspense,
  startTransition,
  useState,
  useEffect,
  useEffectEvent,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useContext,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { LayoutGroup, m } from "framer-motion";
import { logError } from "@/utils/logger";
import { getUiAnimationDuration, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import {
  usePortalStore,
  usePerformanceModeStore,
  useScrollbackStore,
  useLayoutConfigStore,
  useTerminalInputStore,
  useTwoPaneSplitStore,
  usePreferencesStore,
  useSettingsStore,
} from "@/store";
import { X, Search, ChevronRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appClient } from "@/clients";
import type { AppVersionInfo } from "@shared/types/ipc/app";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneralTab } from "./GeneralTab";
import {
  SETTINGS_REGISTRY,
  globalTabTitles,
  globalTabIcons,
  projectTabTitles,
  projectTabIcons,
  getSettingsNavGroups,
  preloadAllSettingsTabs,
  scopeForTab,
  type SettingsTab,
  type SettingsScope,
  type LazySettingsTabEntry,
} from "./settingsTabRegistry";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import {
  filterSettings,
  countMatchesPerTab,
  HighlightText,
  parseQuery,
} from "./settingsSearchUtils";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";
import {
  useProjectSettingsForm,
  type ProjectSettingsFormContext,
} from "@/hooks/useProjectSettingsForm";
import { useFlushOnHide } from "@/hooks/useFlushOnHide";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import {
  SettingsValidationProvider,
  SettingsValidationContext,
} from "./SettingsValidationRegistry";
import { SettingsFlushProvider, SettingsFlushContext } from "./SettingsFlushRegistry";

let rememberedTab: SettingsTab = "general";
let rememberedProjectTab: SettingsTab = "project:general";

// How long the `settings-highlight` pulse stays on the scrolled-to section
// before the class is removed. Long enough to read, short enough not to draw
// attention after the user has oriented.
const SETTINGS_HIGHLIGHT_DECAY_MS = 1500;

// Hover-intent delay before speculatively mounting a settings tab's lazy
// panel. Short enough that the panel's IPC reads are usually settled by the
// time the user clicks; long enough that a mouse sweep across nav items
// doesn't mount every tab at once.
export const SETTINGS_TAB_HOVER_INTENT_MS = 150;

// Version info is immutable for the process lifetime — fetch it once and reuse
// across dialog opens so the About card never shows a placeholder.
let cachedVersionInfo: AppVersionInfo | null = null;

// Lowercase the first letter so the label reads naturally mid-sentence
// ("Requires voice input"), unless it starts with an initialism like
// MCP / AI / API — those stay uppercase.
function midSentenceLabel(label: string): string {
  if (/^[A-Z]{2,}/.test(label)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export interface SettingsNavTarget {
  tab: SettingsTab;
  subtab?: string;
  sectionId?: string;
}

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: SettingsTab;
  defaultSubtab?: string;
  defaultSectionId?: string;
  onSettingsChange?: () => void;
  projectId?: string | null;
}

// SettingsTab, SettingsScope, scopeForTab imported from settingsTabRegistry.
// Re-exported for backward compatibility.
export type { SettingsTab, SettingsScope } from "./settingsTabRegistry";
export { scopeForTab } from "./settingsTabRegistry";

export function SettingsDialog(props: SettingsDialogProps) {
  // Provider must wrap SettingsDialogInner: the inner component reads the registry
  // via useContext to render nav-sidebar error dots.
  return (
    <SettingsValidationProvider>
      <SettingsFlushProvider>
        <SettingsDialogInner {...props} />
      </SettingsFlushProvider>
    </SettingsValidationProvider>
  );
}

function SettingsDialogInner({
  isOpen,
  onClose,
  defaultTab,
  defaultSubtab,
  defaultSectionId,
  onSettingsChange,
  projectId,
}: SettingsDialogProps) {
  const initialTab = defaultTab ?? rememberedTab;
  const [activeScope, setActiveScope] = useState<SettingsScope>(scopeForTab(initialTab));
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(
    () => new Set<SettingsTab>([initialTab])
  );

  // AppDialog uses useAnimatedPresence and keeps children mounted through
  // the ~120ms exit animation, so a hover-intent timer scheduled near close
  // can fire while the dialog is animating out. Read this ref inside the
  // timer callback to skip the speculative mount when the dialog is closing.
  const isOpenRef = useRef(isOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  const hasProject = !!projectId;

  useEffect(() => {
    const id = requestIdleCallback(
      () => {
        preloadAllSettingsTabs();
      },
      { timeout: 4000 }
    );
    return () => cancelIdleCallback(id);
  }, []);

  useEffect(() => {
    if (activeTab.startsWith("project:")) {
      rememberedProjectTab = activeTab;
    } else {
      rememberedTab = activeTab;
    }
  }, [activeTab]);
  const markTabVisited = (tab: SettingsTab) => {
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  };
  const [activeSubtabs, setActiveSubtabs] = useState<Partial<Record<SettingsTab, string>>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const setPortalOpen = usePortalStore((state) => state.setOpen);
  const setTab = useSettingsStore((s) => s.setTab);
  const setSubtab = useSettingsStore((s) => s.setSubtab);

  useEffect(() => {
    if (isOpen) {
      setPortalOpen(false);
    }
  }, [isOpen, setPortalOpen]);

  const [appVersion, setAppVersion] = useState<string>(cachedVersionInfo?.appVersion ?? "");
  const [buildArch, setBuildArch] = useState<string | undefined>(cachedVersionInfo?.arch);

  const [hiddenSettingBanner, setHiddenSettingBanner] = useState<{
    label: string;
    settingId: string;
  } | null>(null);

  // Deep-link: scroll to a specific section after navigating.
  // The active tab's panel subtree fires a `useLayoutEffect` (via
  // `SettingsTabScrollEffect` / `LazyTabContent`) when it commits — that's
  // the only reliable signal that lazy-loaded content is in the DOM, so we
  // drive the scroll from the child rather than polling from the parent.
  const [scrollToSection, setScrollToSection] = useState<string | null>(null);

  // activeTab is read non-reactively via useEffectEvent to avoid re-running
  // this reset-on-open effect when the user changes tabs mid-session.
  const handleOpenChange = useEffectEvent(() => {
    if (isOpen && defaultTab) {
      markTabVisited(defaultTab);
      if (defaultTab !== activeTab) {
        setActiveTab(defaultTab);
      }
      setActiveScope(scopeForTab(defaultTab));
      if (defaultSubtab !== undefined) {
        setActiveSubtabs((prev) => ({ ...prev, [defaultTab]: defaultSubtab }));
      }
      setScrollToSection(defaultSectionId ?? null);
      setSearchQuery("");
    } else if (isOpen) {
      // Untargeted open (toolbar/menu): always land on global scope
      const tab = rememberedTab;
      setActiveScope("global");
      markTabVisited(tab);
      if (tab !== activeTab) {
        startTransition(() => setActiveTab(tab));
      }
      setScrollToSection(null);
      setSearchQuery("");
      setHiddenSettingBanner(null);
    }
  });
  useEffect(() => {
    void isOpen;
    void defaultTab;
    void defaultSubtab;
    void defaultSectionId;
    handleOpenChange();
  }, [isOpen, defaultTab, defaultSubtab, defaultSectionId]);

  useEffect(() => {
    if (isOpen && cachedVersionInfo === null) {
      appClient
        .getVersionInfo()
        .then((info) => {
          cachedVersionInfo = info;
          setAppVersion(info.appVersion);
          setBuildArch(info.arch);
        })
        .catch((error) => {
          logError("Failed to fetch app version info", error);
          setAppVersion("Unavailable");
        });
    }
  }, [isOpen]);

  // Clear search when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
    }
  }, [isOpen]);

  // Sync active tab to store for theme browser bridge
  useEffect(() => {
    setTab(activeTab);
    setSubtab(activeSubtabs[activeTab] ?? null);
  }, [activeTab, activeSubtabs, setTab, setSubtab]);

  // Keyboard shortcut: "/" or Cmd+F focuses search
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isSearchShortcut = e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key === "f");
      const activeEl = document.activeElement as HTMLElement | null;
      const isEditingField =
        ["INPUT", "TEXTAREA"].includes(activeEl?.tagName ?? "") ||
        activeEl?.contentEditable === "true" ||
        activeEl?.isContentEditable === true;

      if (isSearchShortcut && !isEditingField) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Modified-from-default tracking
  const performanceMode = usePerformanceModeStore((s) => s.performanceMode);
  const scrollbackLines = useScrollbackStore((s) => s.scrollbackLines);
  const layoutConfig = useLayoutConfigStore((s) => s.layoutConfig);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((s) => s.hybridInputAutoFocus);
  const twoPaneSplitConfig = useTwoPaneSplitStore((s) => s.config);
  const showProjectPulse = usePreferencesStore((s) => s.showProjectPulse);
  const showDeveloperTools = usePreferencesStore((s) => s.showDeveloperTools);
  const showGridAgentHighlights = usePreferencesStore((s) => s.showGridAgentHighlights);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);
  const dockDensity = usePreferencesStore((s) => s.dockDensity);

  const modifiedTabs = useMemo(() => {
    const tabs = new Set<SettingsTab>();

    // General defaults: showProjectPulse=true, showDeveloperTools=false, showGridAgentHighlights=false, showDockAgentHighlights=false
    if (
      !showProjectPulse ||
      showDeveloperTools ||
      showGridAgentHighlights ||
      showDockAgentHighlights
    )
      tabs.add("general");

    // Terminal defaults: performanceMode=false, scrollback=SCROLLBACK_DEFAULT, strategy=automatic,
    // hybridInput=true, hybridAutoFocus=true, twoPaneSplit.enabled=true, preferPreview=false, ratio=0.5
    if (
      performanceMode ||
      scrollbackLines !== SCROLLBACK_DEFAULT ||
      layoutConfig.strategy !== "automatic" ||
      !hybridInputEnabled ||
      !hybridInputAutoFocus ||
      !twoPaneSplitConfig.enabled ||
      twoPaneSplitConfig.preferPreview ||
      Math.round(twoPaneSplitConfig.defaultRatio * 100) !== 50
    ) {
      tabs.add("terminal");
    }

    if (dockDensity !== "normal") tabs.add("terminalAppearance");

    return tabs;
  }, [
    showProjectPulse,
    showDeveloperTools,
    showGridAgentHighlights,
    showDockAgentHighlights,
    dockDensity,
    performanceMode,
    scrollbackLines,
    layoutConfig.strategy,
    hybridInputEnabled,
    hybridInputAutoFocus,
    twoPaneSplitConfig.enabled,
    twoPaneSplitConfig.preferPreview,
    twoPaneSplitConfig.defaultRatio,
  ]);

  const projectForm = useProjectSettingsForm({ projectId: projectId ?? null, isOpen });
  const showProjectLoading = useDohertyGate(projectForm.projectIsLoading);
  const projectLabel =
    projectForm.currentProject?.name ?? projectForm.currentProject?.id ?? "project";

  // Validation error tracking from the registry provider
  const validationRegistry = useContext(SettingsValidationContext);
  const tabsWithErrors = validationRegistry?.tabsWithErrors ?? new Set();

  // Tabs with their own dirty buffer (env vars, worktree pattern) register
  // a flush callback here so the dialog can persist them on close or detach.
  const flushRegistry = useContext(SettingsFlushContext);
  const flushAllTabs = flushRegistry?.flushAll;

  // Coalesced: a visibility change landing mid-close would otherwise re-issue
  // every registered tab flusher alongside the one already in flight.
  const flushInFlightRef = useRef<Promise<void> | null>(null);
  const flushDialog = () => {
    if (flushInFlightRef.current) return flushInFlightRef.current;
    const pending = (async () => {
      if (flushAllTabs) await flushAllTabs();
      await projectForm.flush();
    })();
    flushInFlightRef.current = pending;
    return pending.finally(() => {
      flushInFlightRef.current = null;
    });
  };

  // Electron 41 WebContentsView detach (project switch, window close) does not
  // fire beforeunload — visibilitychange is the reliable signal. Flushing on
  // hide ensures debounced autosaves and per-tab dirty state persist before
  // the view is evicted.
  useFlushOnHide(flushDialog, isOpen);

  const [globalEnvVars, setGlobalEnvVars] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isOpen) return;
    window.electron.globalEnv
      .get()
      .then(setGlobalEnvVars)
      .catch((err) => {
        // Log only — EnvironmentSettingsTab owns the user-visible failure path
        // when the user opens that tab. Avoid double-toasting the same IPC fail.
        logError("Failed to preload global env vars for agent settings", err);
      });
  }, [isOpen]);

  const handleBeforeClose = async () => {
    await flushDialog();
    return true;
  };

  // AppDialog-mediated closes (Escape, backdrop, the header's close button) have
  // already flushed via onBeforeClose, so this only dismisses. Flushing again
  // would re-issue every tab's persistence IPC and the full project save.
  const handleDialogClose = () => {
    onClose();
  };

  // Handed to tab content via the registry's `needsOnClose` flag. That route
  // never passes through onBeforeClose, so it keeps its own flush — no tab
  // invokes it today (AppThemePicker only tests it for presence), but a caller
  // that did would otherwise close without persisting.
  const handleClose = async () => {
    await flushDialog();
    onClose();
  };

  const searchResults = useMemo(
    () =>
      filterSettings(SETTINGS_SEARCH_INDEX, deferredQuery, {
        modifiedTabs,
        scope: activeScope,
        hasProject,
      }),
    [deferredQuery, modifiedTabs, activeScope, hasProject]
  );

  const cleanSearchQuery = useMemo(() => parseQuery(deferredQuery).cleanQuery, [deferredQuery]);

  const matchCounts = useMemo(() => countMatchesPerTab(searchResults), [searchResults]);

  // Use live searchQuery for mode switching to avoid deferred split-brain;
  // deferredQuery drives the expensive filtering computation only.
  const isSearching = searchQuery.trim().length > 0;

  const handleResultClick = (
    { tab, subtab, sectionId }: SettingsNavTarget,
    requiresEnabled?: { settingId: string; label: string }
  ) => {
    markTabVisited(tab);
    setSearchQuery("");
    setHiddenSettingBanner(requiresEnabled ?? null);
    if (subtab !== undefined) {
      setActiveSubtabs((prev) => ({ ...prev, [tab]: subtab }));
    }
    searchInputRef.current?.blur();
    // Defer scrollToSection together with the tab change. Setting it
    // urgently would let the previously-active tab's effect consume the
    // pending id (it sees isActive=true after the urgent commit but
    // before the transition makes the new tab active). The scope switch
    // must share the transition so the scope toggle and tab content
    // commit together — splitting them yields a torn render where the
    // toggle flips while the panel still shows the previous scope.
    const nextScope = scopeForTab(tab);
    startTransition(() => {
      if (nextScope !== activeScope) {
        setActiveScope(nextScope);
      }
      setActiveTab(tab);
      setScrollToSection(sectionId ?? null);
    });
  };

  const [activeResultIndex, setActiveResultIndex] = useState(-1);

  useEffect(() => {
    setActiveResultIndex(-1);
  }, [deferredQuery]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (searchQuery) {
        e.stopPropagation();
        setSearchQuery("");
      } else {
        searchInputRef.current?.blur();
      }
    } else if (isSearching && searchResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveResultIndex((prev) => (prev < searchResults.length - 1 ? prev + 1 : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveResultIndex((prev) => (prev > 0 ? prev - 1 : searchResults.length - 1));
      } else if (e.key === "Enter" && activeResultIndex >= 0) {
        e.preventDefault();
        const result = searchResults[activeResultIndex];
        if (result) {
          handleResultClick(
            { tab: result.tab, subtab: result.subtab, sectionId: result.id },
            result.requiresEnabled
          );
        }
      }
    }
  };

  const handleScrollToSectionHandled = (sectionId: string) => {
    setScrollToSection((current) => (current === sectionId ? null : current));
  };

  const handleNavSelect = (tab: SettingsTab) => {
    markTabVisited(tab);
    setSearchQuery("");
    setScrollToSection(null);
    setHiddenSettingBanner(null);
    startTransition(() => setActiveTab(tab));
  };

  const handleScopeSwitch = (scope: SettingsScope) => {
    if (scope === activeScope) return;
    setActiveScope(scope);
    setSearchQuery("");
    const tab = scope === "project" ? rememberedProjectTab : rememberedTab;
    markTabVisited(tab);
    startTransition(() => setActiveTab(tab));
  };

  const tablistRef = useRef<HTMLDivElement>(null);

  const handleTablistKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const container = tablistRef.current;
    if (!container) return;

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const focusedIndex = tabs.indexOf(document.activeElement as HTMLElement);
    if (focusedIndex === -1) return;

    let nextIndex: number | null = null;

    switch (e.key) {
      case "ArrowDown":
        nextIndex = (focusedIndex + 1) % tabs.length;
        break;
      case "ArrowUp":
        nextIndex = (focusedIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    // Manual activation: arrow keys move focus only. Native <button role="tab">
    // already fires onClick on Enter/Space, so the existing onSelect handler
    // covers activation without an explicit keydown branch here.
    tabs[nextIndex]!.focus();
  };

  const tabTitles: Record<SettingsTab, string> = {
    ...globalTabTitles,
    ...projectTabTitles,
  };

  const tabIcons: Record<SettingsTab, React.ReactNode> = {
    ...globalTabIcons,
    ...projectTabIcons,
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleDialogClose}
      onBeforeClose={handleBeforeClose}
      size="4xl"
      maxHeight="h-[75vh]"
      className="settings-shell min-h-[500px] max-h-[800px]"
    >
      <div className="flex h-full overflow-hidden">
        <div className="settings-sidebar w-52 border-r border-daintree-border p-3 flex flex-col shrink-0">
          <div className="flex items-center justify-between mb-3 pl-2">
            <h2 className="text-sm font-semibold text-daintree-text">Settings</h2>
            {hasProject && (
              <Select
                value={activeScope}
                onValueChange={(v) => handleScopeSwitch(v as SettingsScope)}
              >
                <SelectTrigger
                  aria-label="Settings scope"
                  // Fallback keeps themes without --settings-scope-bg byte-identical.
                  className="text-xs py-1 pl-2 pr-2 h-auto w-auto gap-1 bg-[var(--settings-scope-bg,transparent)] text-text-secondary hover:text-daintree-text hover:border-daintree-text/30"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="project">Project</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 mb-3 rounded-[var(--radius-md)]",
              "settings-search border border-border-strong",
              "focus-within:border-daintree-accent/40 focus-within:ring-1 focus-within:ring-daintree-accent/20"
            )}
          >
            <Search
              className="settings-search-icon w-3.5 h-3.5 shrink-0 pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label="Search settings"
              className="settings-search-input flex-1 min-w-0 text-xs bg-transparent text-daintree-text focus:outline-hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="flex items-center justify-center w-5 h-5 rounded shrink-0 text-daintree-text/40 hover:text-daintree-text"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {isSearching && (
            <p aria-live="polite" className="sr-only">
              {searchResults.length === 0
                ? "No results found"
                : `${searchResults.length} result${searchResults.length === 1 ? "" : "s"} found`}
            </p>
          )}

          <ScrollShadow
            className="flex-1 min-h-0"
            scrollClassName="space-y-3"
            ref={tablistRef}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={handleTablistKeyDown}
          >
            <LayoutGroup id="settings-nav">
              {getSettingsNavGroups(activeScope).map((group) => (
                <NavGroup key={group.label} label={group.label}>
                  {group.entries.map((entry) => {
                    const tabId = entry.id as SettingsTab;
                    const isLazy = entry.importKind === "lazy";
                    return (
                      <NavItem
                        key={entry.id}
                        tab={tabId}
                        icon={entry.icon}
                        label={entry.label}
                        activeTab={activeTab}
                        isSearching={isSearching}
                        matchCount={matchCounts[tabId]}
                        modified={modifiedTabs.has(tabId)}
                        hasError={tabsWithErrors.has(tabId)}
                        onSelect={handleNavSelect}
                        onPrefetchImport={isLazy ? entry.importer : undefined}
                        onPrefetchMount={
                          isLazy
                            ? () => {
                                if (isOpenRef.current) markTabVisited(tabId);
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                </NavGroup>
              ))}
            </LayoutGroup>
          </ScrollShadow>

          <div className="pt-2 mt-2 border-t border-daintree-border px-2">
            <span className="settings-meta font-mono">{appVersion}</span>
          </div>
        </div>

        <div className="settings-shell flex-1 flex flex-col min-w-0">
          <AppDialog.Header plainBody>
            {/* h3, not the default h2: the sidebar's "Settings" h2 is the shell
                heading and this labels the active section beneath it. */}
            <AppDialog.Title
              as="h3"
              icon={
                isSearching ? (
                  <Search className="w-5 h-5 text-text-secondary" />
                ) : (
                  tabIcons[activeTab]
                )
              }
            >
              {isSearching ? "Search Results" : tabTitles[activeTab]}
            </AppDialog.Title>
            <AppDialog.CloseButton aria-label="Close settings" />
          </AppDialog.Header>

          <ScrollShadow className="flex-1" scrollClassName="p-6">
            {isSearching ? (
              <div role="region" aria-label="Search results">
                <SearchResults
                  results={searchResults}
                  query={deferredQuery}
                  cleanQuery={cleanSearchQuery}
                  onResultClick={handleResultClick}
                  activeIndex={activeResultIndex}
                />
              </div>
            ) : (
              <>
                {hiddenSettingBanner && (
                  <div
                    className="text-sm text-status-warning bg-status-warning/10 border border-status-warning/20 rounded-[var(--radius-md)] p-3 mb-4 flex items-start justify-between gap-3"
                    role="alert"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>
                        This setting is only visible when{" "}
                        <button
                          className="underline font-medium hover:opacity-80"
                          onClick={() => {
                            const parent = SETTINGS_SEARCH_INDEX.find(
                              (e) => e.id === hiddenSettingBanner.settingId
                            );
                            if (parent) {
                              handleResultClick(
                                {
                                  tab: parent.tab,
                                  subtab: parent.subtab,
                                  sectionId: parent.id,
                                },
                                parent.requiresEnabled
                              );
                            }
                          }}
                        >
                          {midSentenceLabel(hiddenSettingBanner.label)}
                        </button>{" "}
                        is enabled.
                      </span>
                    </div>
                    <button
                      aria-label="Dismiss"
                      onClick={() => setHiddenSettingBanner(null)}
                      className="shrink-0 opacity-60 hover:opacity-100"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {SETTINGS_REGISTRY.filter((e) => e.scope === "global").map((entry) => {
                  const tabId = entry.id as SettingsTab;
                  const isActive = activeTab === tabId;
                  return (
                    <div
                      key={entry.id}
                      role="tabpanel"
                      id={`settings-panel-${entry.id}`}
                      aria-labelledby={`settings-tab-${entry.id}`}
                      tabIndex={0}
                      className={isActive ? "" : "hidden"}
                    >
                      {entry.importKind === "eager" ? (
                        // Only GeneralTab is eager — render with its specific props
                        <>
                          <GeneralTab
                            appVersion={appVersion}
                            buildArch={buildArch}
                            onNavigateToAgents={(agentId?: string) => {
                              markTabVisited("agents");
                              if (agentId) {
                                setActiveSubtabs((prev) => ({ ...prev, agents: agentId }));
                              }
                              startTransition(() => setActiveTab("agents"));
                            }}
                            activeSubtab={activeSubtabs["general"] ?? null}
                            onSubtabChange={(id) =>
                              setActiveSubtabs((prev) => ({ ...prev, general: id }))
                            }
                          />
                          <SettingsTabScrollEffect
                            isActive={isActive && !isSearching}
                            scrollToSectionId={scrollToSection}
                            onScrollToSectionHandled={handleScrollToSectionHandled}
                          />
                        </>
                      ) : visitedTabs.has(tabId) ? (
                        <Suspense fallback={null}>
                          <LazyTabContent
                            entry={entry as LazySettingsTabEntry}
                            activeSubtabs={activeSubtabs}
                            setActiveSubtabs={setActiveSubtabs}
                            onClose={handleClose}
                            onSettingsChange={onSettingsChange}
                            isActive={isActive && !isSearching}
                            scrollToSectionId={scrollToSection}
                            onScrollToSectionHandled={handleScrollToSectionHandled}
                          />
                        </Suspense>
                      ) : null}
                    </div>
                  );
                })}

                {/* Project settings panels */}
                {activeScope === "project" && projectId && (
                  <>
                    {projectForm.projectError && (
                      <SettingsLoadErrorBanner
                        message={`Failed to load settings: ${projectForm.projectError}`}
                        onRetry={projectForm.refreshProjectSettings}
                      />
                    )}
                    {showProjectLoading && (
                      <p className="text-sm text-daintree-text/60 py-2" aria-live="polite">
                        Loading settings…
                      </p>
                    )}
                    {projectForm.projectAutoSaveError && (
                      <div
                        className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4"
                        role="alert"
                      >
                        {projectForm.projectAutoSaveError}
                      </div>
                    )}
                    {SETTINGS_REGISTRY.filter((e) => e.scope === "project").map((entry) => {
                      const tabId = entry.id as SettingsTab;
                      const isActive = activeTab === tabId;
                      return (
                        <div
                          key={entry.id}
                          role="tabpanel"
                          id={`settings-panel-${entry.id}`}
                          aria-labelledby={`settings-tab-${entry.id}`}
                          tabIndex={0}
                          className={isActive ? "" : "hidden"}
                        >
                          {visitedTabs.has(tabId) && (
                            <Suspense fallback={null}>
                              <ProjectFormTabContent
                                entry={entry as LazySettingsTabEntry}
                                projectForm={projectForm}
                                projectId={projectId}
                                isOpen={isOpen}
                                globalEnvVars={globalEnvVars}
                                globalScrollbackLines={scrollbackLines}
                                projectLabel={projectLabel}
                                isActive={isActive && !isSearching}
                                scrollToSectionId={scrollToSection}
                                onScrollToSectionHandled={handleScrollToSectionHandled}
                              />
                            </Suspense>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </ScrollShadow>
        </div>
      </div>
    </AppDialog>
  );
}

function LazyTabContent({
  entry,
  activeSubtabs,
  setActiveSubtabs,
  onClose,
  onSettingsChange,
  isActive,
  scrollToSectionId,
  onScrollToSectionHandled,
}: {
  entry: LazySettingsTabEntry;
  activeSubtabs: Partial<Record<SettingsTab, string>>;
  setActiveSubtabs: React.Dispatch<React.SetStateAction<Partial<Record<SettingsTab, string>>>>;
  onClose: () => void;
  onSettingsChange?: () => void;
  isActive: boolean;
  scrollToSectionId: string | null;
  onScrollToSectionHandled: (id: string) => void;
}) {
  const id = entry.id as SettingsTab;
  const activeSubtab = activeSubtabs[id] ?? null;
  const onSubtabChange = entry.needsSubtabs
    ? (next: string) => setActiveSubtabs((prev) => ({ ...prev, [id]: next }))
    : undefined;

  const props: Record<string, unknown> = {};
  if (entry.needsSubtabs) {
    props.activeSubtab = activeSubtab;
    props.onSubtabChange = onSubtabChange;
  }
  if (entry.needsOnClose) {
    props.onClose = onClose;
  }
  if (entry.needsOnSettingsChange) {
    props.onSettingsChange = onSettingsChange;
  }

  // Runs synchronously after the lazy chunk's Suspense boundary commits, so
  // the target section element is guaranteed to exist in the DOM. Replaces
  // the rAF polling loop that was racing the Suspense reveal (#6878).
  useSettingsScrollToSection(isActive, scrollToSectionId, onScrollToSectionHandled);

  const LazyComp = entry.LazyComponent;
  return <LazyComp {...props} />;
}

function ProjectFormTabContent({
  entry,
  projectForm,
  projectId,
  isOpen,
  globalEnvVars,
  globalScrollbackLines,
  projectLabel,
  isActive,
  scrollToSectionId,
  onScrollToSectionHandled,
}: {
  entry: LazySettingsTabEntry;
  projectForm: ProjectSettingsFormContext;
  projectId: string;
  isOpen: boolean;
  globalEnvVars: Record<string, string>;
  globalScrollbackLines: number;
  projectLabel: string;
  isActive: boolean;
  scrollToSectionId: string | null;
  onScrollToSectionHandled: (id: string) => void;
}) {
  useSettingsScrollToSection(isActive, scrollToSectionId, onScrollToSectionHandled);

  const LazyComp = entry.LazyComponent;

  switch (entry.id) {
    case "project:general":
      return (
        <LazyComp
          currentProject={projectForm.currentProject}
          name={projectForm.projectName}
          onNameChange={projectForm.setProjectName}
          emoji={projectForm.projectEmoji}
          onEmojiChange={projectForm.setProjectEmoji}
          color={projectForm.projectColor}
          onColorChange={projectForm.setProjectColor}
          devServerCommand={projectForm.devServerCommand}
          onDevServerCommandChange={projectForm.setDevServerCommand}
          devServerLoadTimeout={projectForm.devServerLoadTimeout}
          onDevServerLoadTimeoutChange={projectForm.setDevServerLoadTimeout}
          turbopackEnabled={projectForm.turbopackEnabled}
          onTurbopackEnabledChange={projectForm.setTurbopackEnabled}
          daintreeMcpTier={projectForm.daintreeMcpTier}
          onDaintreeMcpTierChange={projectForm.setDaintreeMcpTier}
          projectIconSvg={projectForm.projectIconSvg}
          onProjectIconSvgChange={projectForm.setProjectIconSvg}
          enableInRepoSettings={projectForm.enableInRepoSettings}
          disableInRepoSettings={projectForm.disableInRepoSettings}
          projectId={projectId}
          isOpen={isOpen}
        />
      );

    case "project:context":
      return (
        <LazyComp
          excludedPaths={projectForm.excludedPaths}
          onExcludedPathsChange={projectForm.setExcludedPaths}
          copyTreeSettings={projectForm.copyTreeSettings}
          onCopyTreeSettingsChange={projectForm.setCopyTreeSettings}
          worktrees={projectForm.worktrees}
          isOpen={isOpen}
        />
      );

    case "project:variables":
      return (
        <LazyComp
          environmentVariables={projectForm.environmentVariables}
          onEnvironmentVariablesChange={projectForm.setEnvironmentVariables}
          settings={projectForm.projectSettings}
          isOpen={isOpen}
          onFlush={projectForm.flush}
          projectLabel={projectLabel}
          globalEnvironmentVariables={globalEnvVars}
        />
      );

    case "project:automation":
      return (
        <LazyComp
          currentProject={projectForm.currentProject}
          runCommands={projectForm.runCommands}
          onRunCommandsChange={projectForm.setRunCommands}
          branchPrefixMode={projectForm.branchPrefixMode}
          onBranchPrefixModeChange={projectForm.setBranchPrefixMode}
          branchPrefixCustom={projectForm.branchPrefixCustom}
          onBranchPrefixCustomChange={projectForm.setBranchPrefixCustom}
          worktreePathPattern={projectForm.worktreePathPattern}
          onWorktreePathPatternChange={projectForm.setWorktreePathPattern}
          terminalShell={projectForm.terminalShell}
          onTerminalShellChange={projectForm.setTerminalShell}
          onTerminalShellReset={() => projectForm.setTerminalShell(undefined)}
          terminalShellArgs={projectForm.terminalShellArgs}
          onTerminalShellArgsChange={projectForm.setTerminalShellArgs}
          onTerminalShellArgsReset={() => projectForm.setTerminalShellArgs(undefined)}
          terminalDefaultCwd={projectForm.terminalDefaultCwd}
          onTerminalDefaultCwdChange={projectForm.setTerminalDefaultCwd}
          onTerminalDefaultCwdReset={() => projectForm.setTerminalDefaultCwd(undefined)}
          terminalScrollback={projectForm.terminalScrollback}
          onTerminalScrollbackChange={projectForm.setTerminalScrollback}
          onTerminalScrollbackReset={() => projectForm.setTerminalScrollback(undefined)}
          effectiveScrollbackLines={globalScrollbackLines}
          resourceEnvironments={projectForm.resourceEnvironments}
          onResourceEnvironmentsChange={projectForm.setResourceEnvironments}
          activeResourceEnvironment={projectForm.activeResourceEnvironment}
          onActiveResourceEnvironmentChange={projectForm.setActiveResourceEnvironment}
          defaultWorktreeMode={projectForm.defaultWorktreeMode}
          onDefaultWorktreeModeChange={projectForm.setDefaultWorktreeMode}
          isOpen={isOpen}
        />
      );

    case "project:recipes":
      return (
        <LazyComp
          projectId={projectId}
          defaultWorktreeRecipeId={projectForm.defaultWorktreeRecipeId}
          onDefaultWorktreeRecipeIdChange={projectForm.setDefaultWorktreeRecipeId}
          worktreeMap={projectForm.worktreeMap}
          isOpen={isOpen}
        />
      );

    case "project:commands":
      return (
        <LazyComp
          projectId={projectId}
          overrides={projectForm.commandOverrides}
          onChange={projectForm.setCommandOverrides}
        />
      );

    case "project:notifications":
      return (
        <LazyComp
          overrides={projectForm.notificationOverrides}
          onChange={projectForm.setNotificationOverrides}
        />
      );

    case "project:code-forge":
      return (
        <LazyComp
          forgeRemote={projectForm.forgeRemote}
          onForgeRemoteChange={projectForm.setForgeRemote}
          forgeProviderOverride={projectForm.forgeProviderOverride}
          onForgeProviderOverrideChange={projectForm.setForgeProviderOverride}
          projectPath={projectForm.currentProject?.path}
        />
      );

    default:
      // A project-scope registry entry exists but ProjectFormTabContent has no
      // matching case. Surfaces silent-null bugs when entries are added without
      // a renderer mapping.
      logError(
        "ProjectFormTabContent: no renderer for project tab",
        new Error(`Unhandled project settings tab id: ${entry.id}`)
      );
      return null;
  }
}

// Scrolls to the section with the given DOM id, focuses the first input
// within it, and applies the highlight pulse. Returns whether the element
// was found. Stays a module-level helper so it can be unit-tested in
// isolation without React's effect machinery.
export function scrollAndHighlightSettingsSection(sectionId: string): boolean {
  const el = document.getElementById(sectionId);
  if (!el) return false;
  el.scrollIntoView({ behavior: "instant", block: "start" });
  el.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  el.classList.add("settings-highlight");
  setTimeout(() => el.classList.remove("settings-highlight"), SETTINGS_HIGHLIGHT_DECAY_MS);
  return true;
}

// Two-tier hover/focus prefetch for lazy settings tabs.
//
// - `onPrefetchImport` fires synchronously on enter — call the chunk's
//   `import()` thunk. Idempotent: the browser module map dedupes repeat calls.
// - `onPrefetchMount` fires after `delayMs` of sustained hover/focus — used
//   to flip the tab into `visitedTabs` so its hidden panel mounts and the
//   panel's `useEffect` IPC reads run before the user clicks.
//
// The delay timer is cancelled on leave/blur and on unmount to keep a
// mouse-sweep across nav items from mounting every tab at once.
export function useHoverIntentPrefetch({
  onPrefetchImport,
  onPrefetchMount,
  delayMs = SETTINGS_TAB_HOVER_INTENT_MS,
}: {
  onPrefetchImport?: () => void;
  onPrefetchMount?: () => void;
  delayMs?: number;
}): { onEnter: () => void; onLeave: () => void } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    []
  );

  const onEnter = () => {
    onPrefetchImport?.();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (onPrefetchMount) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        onPrefetchMount();
      }, delayMs);
    }
  };

  const onLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return { onEnter, onLeave };
}

// Fires the scroll/highlight when its host subtree commits (via
// useLayoutEffect — runs after DOM mutation, before paint). The active-tab
// guard keeps inactive panels from racing each other when state cycles.
// `onHandled` is called unconditionally so the parent can clear pending
// state even when the section id doesn't resolve to a real DOM element
// (e.g. project tab search entries with non-DOM ids).
export function useSettingsScrollToSection(
  isActive: boolean,
  scrollToSectionId: string | null,
  onHandled: (id: string) => void
): void {
  useLayoutEffect(() => {
    if (!isActive || !scrollToSectionId) return;
    scrollAndHighlightSettingsSection(scrollToSectionId);
    onHandled(scrollToSectionId);
  }, [isActive, scrollToSectionId, onHandled]);
}

function SettingsTabScrollEffect({
  isActive,
  scrollToSectionId,
  onScrollToSectionHandled,
}: {
  isActive: boolean;
  scrollToSectionId: string | null;
  onScrollToSectionHandled: (id: string) => void;
}) {
  useSettingsScrollToSection(isActive, scrollToSectionId, onScrollToSectionHandled);
  return null;
}

export function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="none">
      <span
        className="settings-meta font-medium uppercase tracking-wider px-3 mb-1 block select-none"
        aria-hidden="true"
      >
        {label}
      </span>
      <div role="none" className="space-y-0.5">
        {children}
      </div>
    </div>
  );
}

interface NavItemProps {
  tab: SettingsTab;
  icon: React.ReactNode;
  label: string;
  activeTab: SettingsTab;
  isSearching: boolean;
  matchCount?: number;
  modified?: boolean;
  hasError?: boolean;
  onSelect: (tab: SettingsTab) => void;
  // Fires synchronously on pointer-enter / focus. Use to start downloading
  // the tab's lazy chunk (import() is idempotent, no debounce needed).
  onPrefetchImport?: () => void;
  // Fires after SETTINGS_TAB_HOVER_INTENT_MS of sustained hover or focus.
  // Use to speculatively mount the hidden tab panel so its IPC reads fire
  // before the user clicks. Cancelled on leave/blur.
  onPrefetchMount?: () => void;
}

export function NavItem({
  tab,
  icon,
  label,
  activeTab,
  isSearching,
  matchCount,
  modified,
  hasError,
  onSelect,
  onPrefetchImport,
  onPrefetchMount,
}: NavItemProps) {
  const active = activeTab === tab && !isSearching;
  const selected = activeTab === tab;
  const { onEnter, onLeave } = useHoverIntentPrefetch({
    onPrefetchImport,
    onPrefetchMount,
  });
  return (
    <button
      role="tab"
      id={`settings-tab-${tab}`}
      aria-selected={selected}
      aria-controls={`settings-panel-${tab}`}
      tabIndex={selected ? 0 : -1}
      data-tab={tab}
      onClick={() => onSelect(tab)}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={cn(
        "relative text-left px-3 py-1.5 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2 w-full",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
        "settings-nav-item",
        active ? "text-daintree-text" : "text-text-secondary hover:text-daintree-text"
      )}
      data-active={active ? "true" : undefined}
    >
      {active && (
        // Shared across every nav item in this scope, so selecting another tab
        // projects this same node to its new position (transform-only) instead
        // of unmounting and remounting the marker. Scoping the id keeps a
        // cross-scope jump (a search hit in the other scope) from sliding the
        // marker between two unrelated nav trees. A span, not a div: <button>
        // takes phrasing content only, and `absolute` makes it block anyway.
        // Duration comes from getUiAnimationDuration() rather than the raw
        // constant because performance mode has to collapse this to 0 — it
        // suppresses CSS transitions, but cannot stop motion's JS transform
        // writes, which are exactly what a projection animation emits.
        <m.span
          layoutId={`active-indicator-${scopeForTab(tab)}`}
          layout="position"
          className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-daintree-accent"
          transition={{ duration: getUiAnimationDuration() / 1000, ease: EASE_OUT_EXPO_FM }}
          aria-hidden="true"
          data-settings-nav-indicator="true"
        />
      )}
      <span className="relative">
        {icon}
        {(hasError || modified) && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full",
              hasError ? "bg-status-warning" : "bg-state-modified"
            )}
            role="img"
            aria-label={hasError ? "Contains validation errors" : "Modified from default"}
          />
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {matchCount ? <MatchBadge count={matchCount} /> : null}
    </button>
  );
}

function MatchBadge({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      className="ml-auto text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-tint/10 text-daintree-text/60 leading-none"
    >
      {count}
    </span>
  );
}

function ScopeChip({ scope }: { scope: SettingsScope }) {
  const label = scope === "project" ? "Project" : "Global";
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-tint/10 text-daintree-text/60 leading-none shrink-0">
      {label}
    </span>
  );
}

interface SearchResultsProps {
  results: ReturnType<typeof filterSettings>;
  query: string;
  cleanQuery: string;
  onResultClick: (
    target: SettingsNavTarget,
    requiresEnabled?: { settingId: string; label: string }
  ) => void;
  activeIndex?: number;
}

function SearchResults({
  results,
  query,
  cleanQuery,
  onResultClick,
  activeIndex = -1,
}: SearchResultsProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (results.length === 0) {
    return cleanQuery ? (
      <EmptyState
        variant="filtered-empty"
        scale="canvas"
        title={`No results for "${query}"`}
        description="Try different keywords or check spelling"
      />
    ) : (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title="No modified settings"
        description="No settings have been changed from their defaults"
      />
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-daintree-text/40">
          <span className="tabular-nums">{results.length}</span> result
          {results.length === 1 ? "" : "s"}
        </p>
        <p className="text-[10px] text-daintree-text/30">
          <kbd className="settings-kbd px-1 py-0.5 rounded border font-mono">↑↓</kbd> navigate{" "}
          <kbd className="settings-kbd px-1 py-0.5 rounded border font-mono">↵</kbd> go
        </p>
      </div>
      {results.map((result, index) => (
        <button
          key={result.id}
          ref={index === activeIndex ? activeRef : undefined}
          onClick={() =>
            onResultClick(
              { tab: result.tab, subtab: result.subtab, sectionId: result.id },
              result.requiresEnabled
            )
          }
          className={cn(
            "group w-full text-left p-3 rounded-[var(--radius-md)] border transition-colors",
            index === activeIndex
              ? "bg-overlay-selected border-border-strong"
              : "border-transparent hover:bg-overlay-soft hover:border-daintree-border",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <ScopeChip scope={result.scope} />
                <span className="text-[10px] font-medium text-daintree-text/40 uppercase tracking-wide">
                  {result.tabLabel}
                </span>
                {result.subtabLabel && (
                  <>
                    <span className="text-[10px] text-daintree-text/30">›</span>
                    <span className="text-[10px] text-daintree-text/50">{result.subtabLabel}</span>
                  </>
                )}
                <span className="text-[10px] text-daintree-text/30">›</span>
                <span className="text-[10px] text-daintree-text/50">{result.section}</span>
                {result.requiresEnabled && (
                  <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-status-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-status-warning shrink-0">
                    <AlertTriangle className="w-3 h-3" />
                    Requires {midSentenceLabel(result.requiresEnabled.label)}
                  </span>
                )}
              </div>
              <div className="text-sm font-medium text-daintree-text">
                <HighlightText text={result.title} query={query} />
              </div>
              <div className="text-xs text-daintree-text/50 mt-0.5 leading-relaxed">
                <HighlightText text={result.description} query={query} />
              </div>
            </div>
            <ChevronRight
              className={cn(
                "w-4 h-4 text-daintree-text/20 shrink-0 transition-[color,translate] duration-150",
                index === activeIndex
                  ? "text-daintree-text/40 translate-x-0.5"
                  : "group-hover:text-daintree-text/40"
              )}
            />
          </div>
        </button>
      ))}
    </div>
  );
}
