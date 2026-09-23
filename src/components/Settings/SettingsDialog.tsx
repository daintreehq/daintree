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
import { X, Search, ChevronRight, Info } from "lucide-react";
import { ArrowLeftRight, TriangleAlert } from "@/components/icons";
import { cn } from "@/lib/utils";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { appClient } from "@/clients";
import type { AppVersionInfo } from "@shared/types/ipc/app";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
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
  contentScopeForTab,
  isSettingsTab,
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

// Labels never change with state — the checked segment says which scope is
// active, and swapping the words would make the control read as a toggle.
const SCOPE_OPTIONS = [
  { value: "global" as const, label: "Global" },
  { value: "project" as const, label: "Project" },
];

const SEARCH_ENTRY_BY_ID = new Map(SETTINGS_SEARCH_INDEX.map((entry) => [entry.id, entry]));

/**
 * The settings whose change from default the dialog can see. Not every setting: the
 * rest report a change on their own row (the modified bar and reset button), so the
 * `@modified` empty state names this coverage rather than claiming nothing changed.
 */
export const MODIFIED_TRACKED_IDS = [
  "general-project-pulse",
  "general-developer-tools",
  "general-grid-agent-highlights",
  "general-dock-agent-highlights",
  "terminal-performance-mode",
  "terminal-scrollback",
  "terminal-grid-layout",
  "terminal-hybrid-input",
  "terminal-hybrid-autofocus",
  "terminal-two-pane-split",
  "terminal-preview-layout",
  "terminal-default-ratio",
  "appearance-dock-density",
] as const;
type TrackedSettingId = (typeof MODIFIED_TRACKED_IDS)[number];

/**
 * What `@modified` can see, said wherever its results are: "tracks selected settings in
 * General, Panel grid and Appearance — not project settings". A bare "2 results" read as
 * an exhaustive audit when it is a sample.
 */
export function modifiedCoverageNote(): string {
  const labels = [
    ...new Set(
      MODIFIED_TRACKED_IDS.map((id) => SEARCH_ENTRY_BY_ID.get(id)?.tabLabel).filter(
        (label): label is string => !!label
      )
    ),
  ];
  const pages =
    labels.length <= 1
      ? labels.join("")
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `@modified tracks selected settings in ${pages} — not project settings`;
}

/** The tabs holding at least one of `settingIds` — what the sidebar's modified dot marks. */
export function modifiedTabsFor(settingIds: ReadonlySet<string>): Set<SettingsTab> {
  const tabs = new Set<SettingsTab>();
  for (const id of settingIds) {
    const tab = SEARCH_ENTRY_BY_ID.get(id)?.tab;
    if (tab) tabs.add(tab);
  }
  return tabs;
}

// The page a Tab out of the sidebar lands on. Inset, so the ring sits inside the
// scrollport instead of running under its edge fades and the header.
const SETTINGS_PANEL_CLASS =
  "rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2";

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
      setHiddenSettingBanner(null);
    } else if (isOpen) {
      // Untargeted open (toolbar/menu): always land on global scope
      const tab = rememberedTab;
      markTabVisited(tab);
      startTransition(() => {
        setActiveScope("global");
        setActiveTab(tab);
      });
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

  // Opening lands in search, the way a settings window's filter field does: the
  // likeliest next keystroke is the name of the setting. A deep link to a section
  // hands focus to that section's control instead, so it is left alone.
  useEffect(() => {
    if (!isOpen || defaultSectionId) return;
    const frame = requestAnimationFrame(() =>
      searchInputRef.current?.focus({ preventScroll: true })
    );
    return () => cancelAnimationFrame(frame);
  }, [isOpen, defaultSectionId]);

  // Keyboard shortcut: "/" or Cmd+F focuses search
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isFindChord = (e.metaKey || e.ctrlKey) && e.key === "f";
      const activeEl = document.activeElement as HTMLElement | null;
      const isEditingField =
        ["INPUT", "TEXTAREA"].includes(activeEl?.tagName ?? "") ||
        activeEl?.contentEditable === "true" ||
        activeEl?.isContentEditable === true;

      // A bare "/" is text inside a field; the find chord never is.
      if (isFindChord || (e.key === "/" && !isEditingField)) {
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

  // Tracked per setting so `@modified` lists what actually changed; the sidebar dot is
  // the same set rolled up to the tab each setting lives on.
  const modifiedSettingIds = useMemo(() => {
    const changed: Record<TrackedSettingId, boolean> = {
      "general-project-pulse": !showProjectPulse,
      "general-developer-tools": showDeveloperTools,
      "general-grid-agent-highlights": showGridAgentHighlights,
      "general-dock-agent-highlights": showDockAgentHighlights,
      "terminal-performance-mode": performanceMode,
      "terminal-scrollback": scrollbackLines !== SCROLLBACK_DEFAULT,
      "terminal-grid-layout": layoutConfig.strategy !== "automatic",
      "terminal-hybrid-input": !hybridInputEnabled,
      "terminal-hybrid-autofocus": !hybridInputAutoFocus,
      "terminal-two-pane-split": !twoPaneSplitConfig.enabled,
      "terminal-preview-layout": twoPaneSplitConfig.preferPreview,
      "terminal-default-ratio": Math.round(twoPaneSplitConfig.defaultRatio * 100) !== 50,
      "appearance-dock-density": dockDensity !== "normal",
    };
    return new Set(MODIFIED_TRACKED_IDS.filter((id) => changed[id]));
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

  const modifiedTabs = useMemo(() => modifiedTabsFor(modifiedSettingIds), [modifiedSettingIds]);

  const projectForm = useProjectSettingsForm({ projectId: projectId ?? null, isOpen });
  const showProjectLoading = useDohertyGate(projectForm.projectIsLoading);
  // Never the id: a project id is a sha256, not something to read aloud.
  const projectLabel = projectForm.currentProject?.name ?? "project";

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
        modifiedSettingIds,
        scope: activeScope,
        hasProject,
      }),
    [deferredQuery, modifiedTabs, modifiedSettingIds, activeScope, hasProject]
  );

  const cleanSearchQuery = useMemo(() => parseQuery(deferredQuery).cleanQuery, [deferredQuery]);

  const matchCounts = useMemo(() => countMatchesPerTab(searchResults), [searchResults]);

  // Use live searchQuery for mode switching to avoid deferred split-brain;
  // deferredQuery drives the expensive filtering computation only.
  const isSearching = searchQuery.trim().length > 0;

  // What a gated result depends on, held until its landing reports whether the setting
  // was actually on the page. Showing the note up front claimed the setting was hidden
  // even when its parent was already on.
  const pendingRequirementRef = useRef<{ settingId: string; label: string } | null>(null);

  const handleResultClick = (
    { tab, subtab, sectionId }: SettingsNavTarget,
    requiresEnabled?: { settingId: string; label: string }
  ) => {
    markTabVisited(tab);
    setSearchQuery("");
    setHiddenSettingBanner(null);
    pendingRequirementRef.current = requiresEnabled ?? null;
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

  const searchComboboxAria = settingsSearchComboboxAria(
    searchResults,
    activeResultIndex,
    isSearching
  );

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

  const handleScrollToSectionHandled = (sectionId: string, landed: boolean) => {
    setScrollToSection((current) => (current === sectionId ? null : current));
    const requirement = pendingRequirementRef.current;
    pendingRequirementRef.current = null;
    if (requirement && !landed) setHiddenSettingBanner(requirement);
  };

  const handleNavSelect = (tab: SettingsTab) => {
    setFocusedNavTab(null);
    markTabVisited(tab);
    setSearchQuery("");
    setScrollToSection(null);
    setHiddenSettingBanner(null);
    startTransition(() => setActiveTab(tab));
  };

  const handleScopeSwitch = (scope: SettingsScope) => {
    if (scope === activeScope) return;
    setSearchQuery("");
    setHiddenSettingBanner(null);
    const tab = scope === "project" ? rememberedProjectTab : rememberedTab;
    markTabVisited(tab);
    // Scope rides in the same transition as the tab, for the reason handleResultClick
    // already documents: split across an urgent and a transitional update, a cold lazy
    // tab commits the new scope's chrome while the pane still shows the old scope's
    // content — the header would name the project over Daintree's settings.
    startTransition(() => {
      setActiveScope(scope);
      setActiveTab(tab);
    });
  };

  const tablistRef = useRef<HTMLDivElement>(null);
  // Manual activation: the arrow keys move focus without selecting, so the one tab
  // stop has to follow focus rather than stay on the selected tab. Null means "the
  // selected tab", which is also where it returns once focus leaves the list.
  const [focusedNavTab, setFocusedNavTab] = useState<SettingsTab | null>(null);

  // A deep link or search hit can land on a tab below the nav's fold — MCP, Plugins,
  // Run history — leaving the page with no visible "you are here". Keep the active
  // item on screen, moving the list only as far as it has to.
  useEffect(() => {
    if (!isOpen || isSearching) return;
    const item = tablistRef.current?.querySelector<HTMLElement>(
      `[role="tab"][data-tab="${activeTab}"]`
    );
    item?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, isSearching, activeTab, activeScope]);

  const handleTablistKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const container = tablistRef.current;
    if (!container) return;

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const focusedIndex = tabs.indexOf(document.activeElement as HTMLElement);
    if (focusedIndex === -1) return;

    // Forward Tab leaves the list for the page it selects, as the tabs pattern expects:
    // in DOM order the header's close button sat between them, one extra stop on every
    // trip into the content. Close stays reachable — Shift+Tab from the page.
    if (e.key === "Tab" && !e.shiftKey && !isSearching) {
      const panel = document.getElementById(`settings-panel-${activeTab}`);
      if (panel) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
      }
      return;
    }

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
    const next = tabs[nextIndex]!;
    const nextTab = next.dataset.tab;
    setFocusedNavTab(nextTab && isSettingsTab(nextTab) ? nextTab : null);
    next.focus();
  };

  const handleTablistBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedNavTab(null);
  };

  // What the header says the change lands on. Derived from the ACTIVE TAB's content
  // scope, not the nav scope: `integrations` is filed under the global nav but every
  // control in it writes against the current project, and a header that announced
  // "Daintree" over it would state the wrong scope outright. While search owns the
  // pane there is no active tab to speak for, so the nav scope is the honest answer.
  const headerScope: SettingsScope = isSearching ? activeScope : contentScopeForTab(activeTab);

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
      // Search owns first focus (below), not the first tabbable — which was the scope
      // control, so every open painted a focus ring on "Global" and typing did nothing.
      initialFocus="none"
      maxHeight="h-[75vh]"
      className="settings-shell min-h-[500px] max-h-[800px]"
    >
      <div className="flex h-full overflow-hidden">
        <div
          className="settings-sidebar w-52 border-r border-border-default p-3 flex flex-col shrink-0"
          // Escape clears an active search before it closes the dialog wherever focus sits
          // in the sidebar, not only inside the field — Tab to the nav and back out was
          // otherwise one keypress from losing the whole dialog.
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !searchQuery || e.target === searchInputRef.current) return;
            e.stopPropagation();
            setSearchQuery("");
            searchInputRef.current?.focus();
          }}
        >
          <div className="mb-3 px-2 space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">Settings</h2>
            {hasProject && (
              <SegmentedRadioGroup
                // A radiogroup, not the Select it replaced: two mutually exclusive
                // contexts that rebuild the nav tree are a view switcher, not a field
                // value, and screen readers should hear "1 of 2" rather than a combobox.
                // `settings-scope-control` re-homes --settings-scope-bg onto the thumb,
                // which is the surface the seven light themes authored it for.
                className="settings-scope-control"
                fullWidth
                aria-label="Settings scope"
                value={activeScope}
                onChange={handleScopeSwitch}
                options={SCOPE_OPTIONS}
              />
            )}
          </div>

          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 mb-3 rounded-[var(--radius-md)]",
              // The same boundary token as every text field (`Input`), so a theme that tunes its
              // field edge tunes this one too; the magnifier and placeholder identify it.
              "settings-search border border-border-input",
              // Neutral, the palette input's own focus lift: the sidebar's active marker is
              // this region's accent, and a second accent edge beside it split the eye.
              "focus-within:border-selection-outline focus-within:ring-1 focus-within:ring-selection-outline/50"
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
              {...searchComboboxAria}
              className="settings-search-input flex-1 min-w-0 text-xs bg-transparent text-text-primary focus:outline-hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                // -my keeps the 20px target from growing the 16px field line, which
                // pushed the whole nav down 8px the moment a query was typed.
                className="-my-0.5 flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] shrink-0 text-text-secondary hover:text-text-primary"
              >
                <X className="w-3 h-3" aria-hidden="true" />
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
            // The nav always overflows at ordinary window heights, and the full fade
            // washed a whole row out until it read as a disabled item.
            compact
            ref={tablistRef}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={handleTablistKeyDown}
            onBlur={handleTablistBlur}
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
                        tabStop={(focusedNavTab ?? activeTab) === tabId}
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

          <div className="pt-2 mt-2 border-t border-border-default px-2">
            <span className="settings-meta font-mono">{appVersion}</span>
          </div>
        </div>

        <div className="settings-shell flex-1 flex flex-col min-w-0">
          <AppDialog.Header>
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
              {/* The title is what aria-labelledby points at, so the scope has to be part
                  of it — otherwise opening the modal announces "General, dialog" and never
                  says whose General. It stays screen-reader-only: a second visible heading
                  over every section reads as a double title, and the nav the user just
                  clicked through is the sighted answer to the same question. */}
              <span className="sr-only">
                {scopeAnnouncement(headerScope, hasProject ? projectLabel : null)}
              </span>
              {isSearching ? "Search results" : tabTitles[activeTab]}
              {headerScope !== activeScope && (
                // The one exception to "the nav names the scope": a tab filed under
                // Global whose controls all write to the project. Hidden from the
                // accessible name, which already says so through the sr-only clause.
                <span aria-hidden="true" className="flex font-normal">
                  <ScopeChip scope={headerScope} projectLabel={hasProject ? projectLabel : null} />
                </span>
              )}
            </AppDialog.Title>
            <AppDialog.CloseButton aria-label="Close settings" />
          </AppDialog.Header>

          {/* Project trouble rides above the scrollport, not inside it: an autosave
              failure raised while the user is deep in a long form would otherwise
              render off-screen, and a message that scrolls away is a message the
              user never sees. Naming the project keeps the failure attached to the
              thing it happened to. */}
          {activeScope === "project" && projectId && (
            <div className="px-6 pt-6 space-y-2 shrink-0 empty:hidden">
              {projectForm.projectError && (
                <SettingsLoadErrorBanner
                  title={`Couldn't load settings for ${projectLabel}`}
                  message={projectForm.projectError}
                  onRetry={projectForm.refreshProjectSettings}
                />
              )}
              {projectForm.projectAutoSaveError && (
                <SettingsLoadErrorBanner
                  title={`Couldn't save settings for ${projectLabel}`}
                  message={projectForm.projectAutoSaveError}
                  onRetry={() => void projectForm.saveNow()}
                />
              )}
              {showProjectLoading && (
                <p className="text-xs text-text-secondary" aria-live="polite">
                  Loading settings for {projectLabel}…
                </p>
              )}
            </div>
          )}

          <ScrollShadow className="flex-1" scrollClassName="py-6 dialog-body-inset">
            {isSearching && (
              <div role="region" aria-label="Search results">
                <SearchResults
                  results={searchResults}
                  query={deferredQuery}
                  cleanQuery={cleanSearchQuery}
                  onResultClick={handleResultClick}
                  activeIndex={activeResultIndex}
                  activeScope={activeScope}
                  projectLabel={hasProject ? projectLabel : null}
                />
              </div>
            )}
            {/* Hidden rather than unmounted while search owns the pane. Every nav item
                is a role="tab" whose aria-controls points at one of these panels, and a
                tab pointing at an id that is not in the document is a broken reference
                for assistive tech — the panels have to outlive the search overlay. */}
            <div className={isSearching ? "hidden" : undefined}>
              <>
                {hiddenSettingBanner && (
                  // An explanation, not a warning: nothing is wrong, the setting is
                  // simply behind a switch. So it takes the neutral info treatment the
                  // dependents' disabled reason uses, and the link does the work.
                  <div
                    className="settings-card mb-6 flex items-start gap-2 rounded-[var(--radius-lg)] border border-border-default py-2.5 pl-4 pr-2 text-sm text-text-secondary"
                    role="status"
                  >
                    <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <p className="min-w-0 flex-1 py-px">
                      The setting you opened only appears when{" "}
                      <button
                        type="button"
                        className="rounded-sm font-medium text-text-primary underline underline-offset-2 hover:decoration-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
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
                      is on
                    </p>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => setHiddenSettingBanner(null)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary hover:bg-overlay-soft hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
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
                      className={isActive ? SETTINGS_PANEL_CLASS : "hidden"}
                    >
                      {entry.importKind === "eager" ? (
                        // Only GeneralTab is eager — render with its specific props
                        <>
                          <GeneralTab
                            appVersion={appVersion}
                            buildArch={buildArch}
                            onNavigateToAgents={(agentId?: string) => {
                              markTabVisited("agents");
                              setHiddenSettingBanner(null);
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
                          className={isActive ? SETTINGS_PANEL_CLASS : "hidden"}
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
            </div>
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
  onScrollToSectionHandled: (id: string, landed: boolean) => void;
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
  useSettingsScrollToSection(isActive, scrollToSectionId, onScrollToSectionHandled, id);

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
  onScrollToSectionHandled: (id: string, landed: boolean) => void;
}) {
  useSettingsScrollToSection(
    isActive,
    scrollToSectionId,
    onScrollToSectionHandled,
    entry.id as SettingsTab
  );

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
          onFlush={projectForm.saveNow}
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

    // Reads the project-plugin store and the installed-plugin list directly —
    // none of its state lives in the shared project form, so it takes no props.
    case "project:plugins":
      return <LazyComp />;

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
// The control a landed-on section hands focus to: its setting first (a switch, a
// select, a field), then anything else operable in it. Only looking for an <input>
// left focus stranded in the search box for every switch, select and button row.
const SECTION_CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[role="switch"]:not([disabled])',
  '[role="combobox"]:not([disabled])',
  '[role="radio"][tabindex="0"]',
].join(", ");
const SECTION_FALLBACK_SELECTOR = 'button:not([disabled]), a[href], [tabindex="0"]';

function landOn(el: HTMLElement): void {
  el.scrollIntoView({ behavior: "instant", block: "start" });
  const control =
    el.querySelector<HTMLElement>(SECTION_CONTROL_SELECTOR) ??
    el.querySelector<HTMLElement>(SECTION_FALLBACK_SELECTOR);
  control?.focus({ preventScroll: true });
  el.classList.add("settings-highlight");
  setTimeout(() => el.classList.remove("settings-highlight"), SETTINGS_HIGHLIGHT_DECAY_MS);
}

function sameText(a: string | null | undefined, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

/** The settings row labelled `title` inside `root`, if one renders there. */
function findRowByLabel(root: ParentNode, title: string): HTMLElement | null {
  for (const label of root.querySelectorAll<HTMLElement>("[data-settings-row-label]")) {
    if (sameText(label.textContent, title))
      return label.closest<HTMLElement>("[data-settings-row]");
  }
  return null;
}

/** The section headed `heading` inside `root`. Compares the title text, not a badge. */
function findSectionByTitle(root: ParentNode, heading: string): HTMLElement | null {
  for (const h of root.querySelectorAll<HTMLElement>("[data-settings-section-title]")) {
    if (sameText(h.firstChild?.textContent, heading)) {
      return h.closest<HTMLElement>(".settings-section");
    }
  }
  return null;
}

export function scrollAndHighlightSettingsSection(sectionId: string): boolean {
  const el = document.getElementById(sectionId);
  if (!el) return false;
  // A section id can name a whole section; the result the user picked names one row
  // in it, so land on that row when it is there.
  const entry = SEARCH_ENTRY_BY_ID.get(sectionId);
  landOn((entry && findRowByLabel(el, entry.title)) || el);
  return true;
}

/**
 * Lands on a search target whose id is not in the DOM — most project settings index a
 * virtual id — by the words the page renders: the row labelled with the result's title,
 * else the section it names. Returns whether anything was found.
 */
export function landOnSettingByText(sectionId: string, tab: SettingsTab): boolean {
  const entry = SEARCH_ENTRY_BY_ID.get(sectionId);
  const panel = document.getElementById(`settings-panel-${tab}`);
  if (!entry || entry.kind !== "section" || !panel) return false;
  // A gated setting's section renders while the setting itself is hidden, so landing
  // on the heading would report "found" for a row that is not there. Only its own
  // row counts.
  const target =
    findRowByLabel(panel, entry.title) ??
    (entry.requiresEnabled ? null : findSectionByTitle(panel, entry.section));
  if (!target) return false;
  landOn(target);
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
// A target with no DOM section — a page result, or a project entry with a virtual id —
// lands on the page's own nav tab, so the keyboard user arrives somewhere that names
// the page and one Tab away from its content, instead of on a blurred search box.
//
// `onHandled` learns whether the setting itself was found. A section result that is
// not on the page is one hidden behind a switch, which is what the dialog's
// "only appears when" note exists to explain — and only then.
export function useSettingsScrollToSection(
  isActive: boolean,
  scrollToSectionId: string | null,
  onHandled: (id: string, landed: boolean) => void,
  tab?: SettingsTab
): void {
  useLayoutEffect(() => {
    if (!isActive || !scrollToSectionId) return;
    const landed =
      scrollAndHighlightSettingsSection(scrollToSectionId) ||
      (tab !== undefined && landOnSettingByText(scrollToSectionId, tab));
    if (!landed && tab) {
      document.getElementById(`settings-tab-${tab}`)?.focus({ preventScroll: true });
    }
    onHandled(scrollToSectionId, landed);
  }, [isActive, scrollToSectionId, onHandled, tab]);
}

function SettingsTabScrollEffect({
  isActive,
  scrollToSectionId,
  onScrollToSectionHandled,
}: {
  isActive: boolean;
  scrollToSectionId: string | null;
  onScrollToSectionHandled: (id: string, landed: boolean) => void;
}) {
  useSettingsScrollToSection(isActive, scrollToSectionId, onScrollToSectionHandled, "general");
  return null;
}

export function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="none">
      <span
        // Sentence case like every other label in the dialog — the group names are
        // already written that way, and forcing them to capitals made the sidebar the
        // one place that shouted.
        className="text-xs font-medium text-text-secondary px-3 mb-1 block select-none"
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
  /** Holds the list's one tab stop. Defaults to the selected tab. */
  tabStop?: boolean;
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
  tabStop,
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
      tabIndex={(tabStop ?? selected) ? 0 : -1}
      data-tab={tab}
      onClick={() => onSelect(tab)}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={cn(
        // scroll-my clears the list's 16px scroll fade, so keeping the active item in
        // view never parks it under the fade where it reads as dimmed.
        "relative text-left px-3 py-1.5 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2 w-full scroll-my-6",
        // Inset, like the subtab bar: the item spans the scrollport, so a positive
        // offset had both vertical sides of the ring clipped away.
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
        "settings-nav-item",
        active ? "text-text-primary" : "text-text-secondary hover:text-text-primary"
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
          className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-full bg-accent-primary"
          transition={{ duration: getUiAnimationDuration() / 1000, ease: EASE_OUT_EXPO_FM }}
          aria-hidden="true"
          data-settings-nav-indicator="true"
        />
      )}
      <span className="relative">
        {icon}
        {/* "Changed" and "broken" used to be the same dot in two hues, which is no
            distinction at all under achromatopsia or forced colors. The shapes differ
            now — a filled dot for modified, a triangle for a validation error — so the
            two survive colour being removed. */}
        {(hasError || modified) && (
          <span
            className="absolute -top-1.5 -right-1.5 flex items-center justify-center"
            role="img"
            aria-label={hasError ? "Contains validation errors" : "Modified from default"}
          >
            {hasError ? (
              <TriangleAlert
                className="w-2.5 h-2.5 text-status-warning forced-colors:text-[CanvasText]"
                strokeWidth={3}
                aria-hidden="true"
              />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-state-modified forced-colors:bg-[CanvasText]" />
            )}
          </span>
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
      className="ml-auto text-3xs font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-tint/10 text-text-secondary leading-none"
    >
      {count}
    </span>
  );
}

/**
 * The clause the dialog's accessible name opens with, so a screen reader hears whose
 * General it just landed on rather than a bare "General, dialog". Nothing renders it
 * visibly — the sighted answer is the nav the user clicked through.
 *
 * The scope branches before the entity does, and the two are separate questions.
 * `integrations` is filed under the global nav but every control in it writes against
 * the current project, so a project-scoped pane is reachable with no project open;
 * folding that case into the global branch would announce "Global settings for
 * Daintree" over it outright. With no project there is simply no entity to name, which
 * is what the shorter project clause says.
 *
 * @param project the project's label, or null when no project is open.
 */
export function scopeAnnouncement(scope: SettingsScope, project: string | null): string {
  if (scope !== "project") return "Global settings for Daintree, ";
  return project === null ? "Project settings, " : `Project settings for ${project}, `;
}

/**
 * The scope marker on a search result. Unlike the header there is no scope control
 * beside it, so this one spells the scope out — and names the project, because a
 * result that says only "Project" does not tell you which one you are about to edit.
 */
export function ScopeChip({
  scope,
  projectLabel,
  crossScope,
}: {
  scope: SettingsScope;
  projectLabel: string | null;
  /** The result lives in the scope the user is NOT currently in. */
  crossScope?: boolean;
}) {
  const isProject = scope === "project" && projectLabel !== null;
  const scopeWord = scope === "project" ? "Project" : "Global";
  const entity = isProject ? projectLabel : null;
  const title = crossScope
    ? `Switches to ${scopeWord.toLowerCase()} settings${entity ? ` for ${entity}` : ""}`
    : undefined;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 max-w-[14rem] min-w-0 shrink-0",
        "text-3xs font-medium leading-none px-1.5 py-0.5 rounded-full",
        // Neutral by construction: this sits next to N other results and the dialog's
        // one accent is already spent on the nav's active marker.
        crossScope ? "bg-tint/20 text-text-primary" : "bg-tint/10 text-text-secondary"
      )}
      title={title}
    >
      {crossScope && (
        <>
          <ArrowLeftRight className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">Switches to </span>
        </>
      )}
      <span className="shrink-0">{scopeWord}</span>
      {entity && (
        <>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
          <span className="truncate">{entity}</span>
        </>
      )}
    </span>
  );
}

/**
 * Where a result lives, in the words the sidebar and the page use: page, then subtab,
 * then section. A page result is the page itself, so it says so instead of repeating
 * its own title, and a section named the same as the result's title (or its subtab)
 * is dropped rather than printed twice.
 */
export function resultBreadcrumb(result: {
  kind: "tab-nav" | "section";
  tabLabel: string;
  subtabLabel?: string;
  section: string;
  title: string;
}): string[] {
  if (result.kind === "tab-nav") return ["Page"];
  const crumbs = [result.tabLabel];
  const seen = new Set([result.tabLabel.toLowerCase(), result.title.toLowerCase()]);
  for (const part of [result.subtabLabel, result.section]) {
    if (!part || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    crumbs.push(part);
  }
  return crumbs;
}

/** The listbox half of the search combobox; `aria-controls` points here. */
export const SEARCH_RESULTS_LISTBOX_ID = "settings-search-results";

/**
 * Stable DOM id for a result row, shared by the row and by the search input's
 * `aria-activedescendant` — the accessible counterpart of the visual highlight.
 */
export function searchResultOptionId(resultId: string | undefined): string | undefined {
  return resultId === undefined ? undefined : `settings-search-result-${resultId}`;
}

/**
 * The combobox half of the APG pattern, spread onto the search input.
 *
 * The listbox only exists while results are on screen — `SearchResults` swaps
 * in an EmptyState at zero — so expanded/controls/activedescendant are gated on
 * that same condition rather than on the query alone, and the input never
 * points at an id that isn't in the document.
 */
export function settingsSearchComboboxAria(
  results: readonly { id: string }[],
  activeIndex: number,
  isSearching: boolean
) {
  const isOpen = isSearching && results.length > 0;
  return {
    role: "combobox" as const,
    "aria-autocomplete": "list" as const,
    "aria-expanded": isOpen,
    "aria-controls": isOpen ? SEARCH_RESULTS_LISTBOX_ID : undefined,
    "aria-activedescendant":
      isOpen && activeIndex >= 0 ? searchResultOptionId(results[activeIndex]?.id) : undefined,
  };
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
  activeScope: SettingsScope;
  /** null when no project is open. */
  projectLabel: string | null;
}

export function SearchResults({
  results,
  query,
  cleanQuery,
  onResultClick,
  activeIndex = -1,
  activeScope,
  projectLabel,
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
        title="No tracked changes"
        description={`${modifiedCoverageNote()}. Other changes are marked on their own rows.`}
      />
    );
  }

  // One scope exists without a project, so a chip on every row would say nothing.
  const showScope = projectLabel !== null;
  const filteringModified = parseQuery(query).filterModified;

  return (
    <div>
      <div className={cn("flex items-center justify-between", filteringModified ? "mb-1" : "mb-3")}>
        <p className="text-xs text-text-secondary">
          <span className="tabular-nums">{results.length}</span> result
          {results.length === 1 ? "" : "s"}
        </p>
        {/* Real instructions, not a placeholder — they take the secondary ramp. */}
        <p className="shrink-0 whitespace-nowrap text-3xs text-text-secondary">
          <kbd className="settings-kbd px-1 py-0.5 rounded-sm border font-mono">↑↓</kbd> navigate{" "}
          <kbd className="settings-kbd px-1 py-0.5 rounded-sm border font-mono">↵</kbd> open
        </p>
      </div>
      {filteringModified && (
        // Its own line: beside the count it wrapped and crushed the key hints.
        <p className="mb-3 text-xs text-text-secondary">{modifiedCoverageNote()}</p>
      )}
      <div
        id={SEARCH_RESULTS_LISTBOX_ID}
        role="listbox"
        aria-label="Search results"
        className="space-y-1"
      >
        {results.map((result, index) => {
          const crumbs = resultBreadcrumb(result);
          return (
            <button
              key={result.id}
              id={searchResultOptionId(result.id)}
              // The button IS the option — a role="option" wrapper around a button
              // would nest interactive roles. Overriding the implicit button role
              // keeps the click while giving the listbox the child it requires and
              // the input something to point at.
              //
              // Out of the Tab sequence: focus is virtual and owned by the input.
              // Left tabbable, a Tab into a row moved DOM focus without moving the
              // highlight, and the arrow keys — handled on the input — went dead.
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              ref={index === activeIndex ? activeRef : undefined}
              onClick={() =>
                onResultClick(
                  { tab: result.tab, subtab: result.subtab, sectionId: result.id },
                  result.requiresEnabled
                )
              }
              className={cn(
                // The app's one "Enter acts on this row" treatment — the neutral
                // selection-outline rail carries the 3:1 the raised fill cannot.
                PALETTE_ROW_CLASS,
                "group w-full text-left p-3 rounded-[var(--radius-md)]",
                "hover:bg-overlay-soft",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
              )}
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 min-w-0">
                    {showScope && (
                      <ScopeChip
                        // What the setting writes to, which is not always the nav list
                        // it is filed under (`integrations`). Only a row whose nav and
                        // effect agree can promise that opening it switches scope.
                        scope={result.effectScope ?? result.scope}
                        projectLabel={projectLabel}
                        crossScope={
                          result.scope !== activeScope &&
                          (result.effectScope ?? result.scope) === result.scope
                        }
                      />
                    )}
                    <span className="flex min-w-0 items-center gap-1 text-3xs text-text-secondary">
                      {crumbs.map((crumb, i) => (
                        <span key={i} className="flex min-w-0 items-center gap-1">
                          {i > 0 && (
                            <ChevronRight
                              className="h-2.5 w-2.5 shrink-0 text-text-muted"
                              aria-hidden="true"
                            />
                          )}
                          <span className={cn("truncate", i === 0 && "font-medium")}>{crumb}</span>
                        </span>
                      ))}
                    </span>
                    {result.requiresEnabled && (
                      // Where the row lives, not a verdict on it: true whether or not the
                      // parent is on right now, and plain text so it cannot be read as a
                      // second scope chip.
                      <span className="ml-auto shrink-0 text-3xs text-text-secondary">
                        Only when {midSentenceLabel(result.requiresEnabled.label)} is on
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium text-text-primary">
                    <HighlightText text={result.title} query={query} />
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                    <HighlightText text={result.description} query={query} />
                  </div>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "w-4 h-4 shrink-0 transition-[color,translate] duration-150",
                    index === activeIndex
                      ? "text-text-secondary translate-x-0.5"
                      : "text-text-muted group-hover:text-text-secondary"
                  )}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
