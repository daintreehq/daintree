import {
  Suspense,
  lazy,
  startTransition,
  useState,
  useEffect,
  useEffectEvent,
  useDeferredValue,
  useMemo,
  useRef,
  useCallback,
  useContext,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
import {
  X,
  Blocks,
  Github,
  LayoutGrid,
  Mic,
  PanelRight,
  Keyboard,
  SquareTerminal,
  Settings as SettingsIcon,
  Settings2,
  LifeBuoy,
  Bell,
  Search,
  ChevronRight,
  KeyRound,
  Shield,
  FileCode,
  GitBranch,
  Command,
  AlertTriangle,
} from "lucide-react";
import {
  WorktreeIcon,
  DaintreeAgentIcon,
  TerminalRecipeIcon,
  McpServerIcon,
} from "@/components/icons";
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
import { AppDialog } from "@/components/ui/AppDialog";
import { GeneralTab } from "./GeneralTab";
const importAgentSettings = () => import("./AgentSettings");
const importTerminalSettingsTab = () => import("./TerminalSettingsTab");
const importTerminalAppearanceTab = () => import("./TerminalAppearanceTab");
const importGitHubSettingsTab = () => import("./GitHubSettingsTab");
const importTroubleshootingTab = () => import("./TroubleshootingTab");
const importNotificationSettingsTab = () => import("./NotificationSettingsTab");
const importPortalSettingsTab = () => import("./PortalSettingsTab");
const importKeyboardShortcutsTab = () => import("./KeyboardShortcutsTab");
const importWorktreeSettingsTab = () => import("./WorktreeSettingsTab");
const importToolbarSettingsTab = () => import("./ToolbarSettingsTab");
const importIntegrationsTab = () => import("./IntegrationsTab");
const importVoiceInputSettingsTab = () => import("./VoiceInputSettingsTab");

const importMcpServerSettingsTab = () => import("./McpServerSettingsTab");
const importEnvironmentSettingsTab = () => import("./EnvironmentSettingsTab");
const importPrivacyDataTab = () => import("./PrivacyDataTab");

const LazyAgentSettings = lazy(() =>
  importAgentSettings().then((m) => ({ default: m.AgentSettings }))
);
const LazyTerminalSettingsTab = lazy(() =>
  importTerminalSettingsTab().then((m) => ({ default: m.TerminalSettingsTab }))
);
const LazyTerminalAppearanceTab = lazy(() =>
  importTerminalAppearanceTab().then((m) => ({ default: m.TerminalAppearanceTab }))
);
const LazyGitHubSettingsTab = lazy(() =>
  importGitHubSettingsTab().then((m) => ({ default: m.GitHubSettingsTab }))
);
const LazyTroubleshootingTab = lazy(() =>
  importTroubleshootingTab().then((m) => ({ default: m.TroubleshootingTab }))
);
const LazyNotificationSettingsTab = lazy(() =>
  importNotificationSettingsTab().then((m) => ({ default: m.NotificationSettingsTab }))
);
const LazyPortalSettingsTab = lazy(() =>
  importPortalSettingsTab().then((m) => ({ default: m.PortalSettingsTab }))
);
const LazyKeyboardShortcutsTab = lazy(() =>
  importKeyboardShortcutsTab().then((m) => ({ default: m.KeyboardShortcutsTab }))
);
const LazyWorktreeSettingsTab = lazy(() =>
  importWorktreeSettingsTab().then((m) => ({ default: m.WorktreeSettingsTab }))
);
const LazyToolbarSettingsTab = lazy(() =>
  importToolbarSettingsTab().then((m) => ({ default: m.ToolbarSettingsTab }))
);
const LazyIntegrationsTab = lazy(() =>
  importIntegrationsTab().then((m) => ({ default: m.IntegrationsTab }))
);
const LazyVoiceInputSettingsTab = lazy(() =>
  importVoiceInputSettingsTab().then((m) => ({ default: m.VoiceInputSettingsTab }))
);

const LazyMcpServerSettingsTab = lazy(() =>
  importMcpServerSettingsTab().then((m) => ({ default: m.McpServerSettingsTab }))
);
const LazyEnvironmentSettingsTab = lazy(() =>
  importEnvironmentSettingsTab().then((m) => ({ default: m.EnvironmentSettingsTab }))
);
const LazyPrivacyDataTab = lazy(() =>
  importPrivacyDataTab().then((m) => ({ default: m.PrivacyDataTab }))
);

function preloadAllSettingsTabs() {
  importAgentSettings();
  importTerminalSettingsTab();
  importTerminalAppearanceTab();
  importGitHubSettingsTab();
  importTroubleshootingTab();
  importNotificationSettingsTab();
  importPortalSettingsTab();
  importKeyboardShortcutsTab();
  importWorktreeSettingsTab();
  importToolbarSettingsTab();
  importIntegrationsTab();
  importVoiceInputSettingsTab();

  importMcpServerSettingsTab();
  importEnvironmentSettingsTab();
  importPrivacyDataTab();
}
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import {
  filterSettings,
  countMatchesPerTab,
  HighlightText,
  parseQuery,
} from "./settingsSearchUtils";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";
import { useProjectSettingsForm } from "@/hooks/useProjectSettingsForm";
import { GeneralTab as ProjectGeneralTab } from "@/components/Project/GeneralTab";
import { ContextTab as ProjectContextTab } from "@/components/Project/ContextTab";
import { EnvironmentVariablesEditor } from "@/components/Project/EnvironmentVariablesEditor";
import { AutomationTab as ProjectAutomationTab } from "@/components/Project/AutomationTab";
import { RecipesTab as ProjectRecipesTab } from "@/components/Project/RecipesTab";
import { CommandOverridesTab } from "./CommandOverridesTab";
import { ProjectNotificationsTab } from "@/components/Project/ProjectNotificationsTab";
import { GitHubTab as ProjectGitHubTab } from "@/components/Project/GitHubTab";
import {
  SettingsValidationProvider,
  SettingsValidationContext,
} from "./SettingsValidationRegistry";

let rememberedTab: SettingsTab = "general";
let rememberedProjectTab: SettingsTab = "project:general";

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

export type SettingsTab =
  | "general"
  | "keyboard"
  | "terminal"
  | "terminalAppearance"
  | "worktree"
  | "agents"
  | "github"
  | "portal"
  | "toolbar"
  | "notifications"
  | "integrations"
  | "voice"
  | "mcp"
  | "environment"
  | "privacy"
  | "troubleshooting"
  | "project:general"
  | "project:context"
  | "project:variables"
  | "project:automation"
  | "project:recipes"
  | "project:commands"
  | "project:notifications"
  | "project:github";

export type SettingsScope = "global" | "project";

function scopeForTab(tab: SettingsTab): SettingsScope {
  return tab.startsWith("project:") ? "project" : "global";
}

export function SettingsDialog(props: SettingsDialogProps) {
  // Provider must wrap SettingsDialogInner: the inner component reads the registry
  // via useContext to render nav-sidebar error dots.
  return (
    <SettingsValidationProvider>
      <SettingsDialogInner {...props} />
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
  const markTabVisited = useCallback((tab: SettingsTab) => {
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);
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

  const [appVersion, setAppVersion] = useState<string>("Loading...");

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
    if (isOpen) {
      appClient
        .getVersion()
        .then(setAppVersion)
        .catch((error) => {
          console.error("Failed to fetch app version:", error);
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
  const projectLabel =
    projectForm.currentProject?.name ?? projectForm.currentProject?.id ?? "project";

  // Validation error tracking from the registry provider
  const validationRegistry = useContext(SettingsValidationContext);
  const tabsWithErrors = validationRegistry?.tabsWithErrors ?? new Set();

  const [globalEnvVars, setGlobalEnvVars] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!isOpen) return;
    window.electron.globalEnv
      .get()
      .then(setGlobalEnvVars)
      .catch(() => {});
  }, [isOpen]);

  const handleBeforeClose = useCallback(async () => {
    await projectForm.flush();
    return true;
  }, [projectForm]);

  const handleClose = useCallback(async () => {
    await projectForm.flush();
    onClose();
  }, [onClose, projectForm]);

  const searchResults = useMemo(
    () =>
      filterSettings(SETTINGS_SEARCH_INDEX, deferredQuery, { modifiedTabs, scope: activeScope }),
    [deferredQuery, modifiedTabs, activeScope]
  );

  const cleanSearchQuery = useMemo(() => parseQuery(deferredQuery).cleanQuery, [deferredQuery]);

  const matchCounts = useMemo(() => countMatchesPerTab(searchResults), [searchResults]);

  // Use live searchQuery for mode switching to avoid deferred split-brain;
  // deferredQuery drives the expensive filtering computation only.
  const isSearching = searchQuery.trim().length > 0;

  const [hiddenSettingBanner, setHiddenSettingBanner] = useState<{
    label: string;
    settingId: string;
  } | null>(null);

  const handleResultClick = (
    { tab, subtab, sectionId }: SettingsNavTarget,
    requiresEnabled?: { settingId: string; label: string }
  ) => {
    markTabVisited(tab);
    setSearchQuery("");
    setScrollToSection(sectionId ?? null);
    setHiddenSettingBanner(requiresEnabled ?? null);
    if (subtab !== undefined) {
      setActiveSubtabs((prev) => ({ ...prev, [tab]: subtab }));
    }
    searchInputRef.current?.blur();
    startTransition(() => setActiveTab(tab));
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

  // Deep-link: scroll to a specific section after navigating
  const [scrollToSection, setScrollToSection] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollToSection || isSearching) return;
    let highlightTimer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const maxAttempts = 20;
    const tryScroll = () => {
      const el = document.getElementById(scrollToSection);
      if (el && el.offsetParent !== null) {
        el.scrollIntoView({ behavior: "instant", block: "start" });
        el.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
        el.classList.add("settings-highlight");
        highlightTimer = setTimeout(() => el.classList.remove("settings-highlight"), 1500);
        return;
      }
      attempt++;
      if (attempt < maxAttempts) {
        frameIds.push(requestAnimationFrame(tryScroll));
      }
    };
    const frameIds: number[] = [];
    frameIds.push(requestAnimationFrame(tryScroll));
    return () => {
      frameIds.forEach(cancelAnimationFrame);
      clearTimeout(highlightTimer);
    };
  }, [scrollToSection, activeTab, isSearching]);

  const handleNavSelect = useCallback(
    (tab: SettingsTab) => {
      markTabVisited(tab);
      setSearchQuery("");
      setScrollToSection(null);
      setHiddenSettingBanner(null);
      startTransition(() => setActiveTab(tab));
    },
    [markTabVisited]
  );

  const handleScopeSwitch = useCallback(
    (scope: SettingsScope) => {
      if (scope === activeScope) return;
      setActiveScope(scope);
      setSearchQuery("");
      const tab = scope === "project" ? rememberedProjectTab : rememberedTab;
      markTabVisited(tab);
      startTransition(() => setActiveTab(tab));
    },
    [activeScope, markTabVisited]
  );

  const tablistRef = useRef<HTMLDivElement>(null);

  const handleTablistKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
      tabs[nextIndex]!.focus();
      const tabId = tabs[nextIndex]!.dataset.tab as SettingsTab | undefined;
      if (tabId) handleNavSelect(tabId);
    },
    [handleNavSelect]
  );

  const tabTitles: Record<SettingsTab, string> = {
    general: "General",
    keyboard: "Keyboard Shortcuts",
    terminal: "Panel Grid",
    terminalAppearance: "Appearance",
    worktree: "Worktree Paths",
    agents: "CLI Agents",
    github: "GitHub Integration",
    portal: "Portal Links",
    toolbar: "Toolbar Customization",
    notifications: "Notifications",
    integrations: "Integrations",
    voice: "Voice Input",

    mcp: "MCP Server",
    environment: "Environment Variables",
    privacy: "Privacy & Data",
    troubleshooting: "Troubleshooting",
    "project:general": "General",
    "project:context": "Context",
    "project:variables": "Variables",
    "project:automation": "Worktree Setup",
    "project:recipes": "Recipes",
    "project:commands": "Commands",
    "project:notifications": "Notifications",
    "project:github": "GitHub",
  };

  const tabIcons: Record<SettingsTab, React.ReactNode> = {
    general: <Settings2 className="w-5 h-5 text-text-secondary" />,
    keyboard: <Keyboard className="w-5 h-5 text-text-secondary" />,
    terminal: <LayoutGrid className="w-5 h-5 text-text-secondary" />,
    terminalAppearance: <SquareTerminal className="w-5 h-5 text-text-secondary" />,
    worktree: <WorktreeIcon className="w-5 h-5 text-text-secondary" />,
    agents: <DaintreeAgentIcon className="w-5 h-5 text-text-secondary" />,
    github: <Github className="w-5 h-5 text-text-secondary" />,
    portal: <PanelRight className="w-5 h-5 text-text-secondary" />,
    toolbar: <SettingsIcon className="w-5 h-5 text-text-secondary" />,
    notifications: <Bell className="w-5 h-5 text-text-secondary" />,
    integrations: <Blocks className="w-5 h-5 text-text-secondary" />,
    voice: <Mic className="w-5 h-5 text-text-secondary" />,

    mcp: <McpServerIcon className="w-5 h-5 text-text-secondary" />,
    environment: <KeyRound className="w-5 h-5 text-text-secondary" />,
    privacy: <Shield className="w-5 h-5 text-text-secondary" />,
    troubleshooting: <LifeBuoy className="w-5 h-5 text-text-secondary" />,
    "project:general": <SettingsIcon className="w-5 h-5 text-text-secondary" />,
    "project:context": <FileCode className="w-5 h-5 text-text-secondary" />,
    "project:variables": <KeyRound className="w-5 h-5 text-text-secondary" />,
    "project:automation": <GitBranch className="w-5 h-5 text-text-secondary" />,
    "project:recipes": <TerminalRecipeIcon className="w-5 h-5 text-text-secondary" />,
    "project:commands": <Command className="w-5 h-5 text-text-secondary" />,
    "project:notifications": <Bell className="w-5 h-5 text-text-secondary" />,
    "project:github": <Github className="w-5 h-5 text-text-secondary" />,
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleClose}
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
                  className="text-xs py-1 pl-2 pr-2 h-auto w-auto gap-1 bg-transparent text-text-secondary hover:text-daintree-text hover:border-daintree-text/30"
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
              "focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
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
              className="settings-search-input flex-1 min-w-0 text-xs bg-transparent text-daintree-text focus:outline-none"
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
            {activeScope === "global" ? (
              <>
                <NavGroup label="General">
                  <NavItem
                    tab="general"
                    icon={<Settings2 className="w-4 h-4" />}
                    label="General"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.general}
                    modified={modifiedTabs.has("general")}
                    hasError={tabsWithErrors.has("general")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="terminalAppearance"
                    icon={<SquareTerminal className="w-4 h-4" />}
                    label="Appearance"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.terminalAppearance}
                    modified={modifiedTabs.has("terminalAppearance")}
                    hasError={tabsWithErrors.has("terminalAppearance")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="keyboard"
                    icon={<Keyboard className="w-4 h-4" />}
                    label="Keyboard"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.keyboard}
                    hasError={tabsWithErrors.has("keyboard")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="notifications"
                    icon={<Bell className="w-4 h-4" />}
                    label="Notifications"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.notifications}
                    hasError={tabsWithErrors.has("notifications")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="privacy"
                    icon={<Shield className="w-4 h-4" />}
                    label="Privacy & Data"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.privacy}
                    hasError={tabsWithErrors.has("privacy")}
                    onSelect={handleNavSelect}
                  />
                </NavGroup>
                <NavGroup label="Terminal">
                  <NavItem
                    tab="terminal"
                    icon={<LayoutGrid className="w-4 h-4" />}
                    label="Panel Grid"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.terminal}
                    modified={modifiedTabs.has("terminal")}
                    hasError={tabsWithErrors.has("terminal")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="worktree"
                    icon={<WorktreeIcon className="w-4 h-4" />}
                    label="Worktree"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.worktree}
                    hasError={tabsWithErrors.has("worktree")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="toolbar"
                    icon={<SettingsIcon className="w-4 h-4" />}
                    label="Toolbar"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.toolbar}
                    hasError={tabsWithErrors.has("toolbar")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="environment"
                    icon={<KeyRound className="w-4 h-4" />}
                    label="Environment"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.environment}
                    hasError={tabsWithErrors.has("environment")}
                    onSelect={handleNavSelect}
                  />
                </NavGroup>
                <NavGroup label="Integrations">
                  <NavItem
                    tab="agents"
                    icon={<DaintreeAgentIcon className="w-4 h-4" />}
                    label="CLI Agents"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.agents}
                    hasError={tabsWithErrors.has("agents")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="github"
                    icon={<Github className="w-4 h-4" />}
                    label="GitHub"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.github}
                    hasError={tabsWithErrors.has("github")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="integrations"
                    icon={<Blocks className="w-4 h-4" />}
                    label="Integrations"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.integrations}
                    hasError={tabsWithErrors.has("integrations")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="voice"
                    icon={<Mic className="w-4 h-4" />}
                    label="Voice Input"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.voice}
                    hasError={tabsWithErrors.has("voice")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="portal"
                    icon={<PanelRight className="w-4 h-4" />}
                    label="Portal"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.portal}
                    hasError={tabsWithErrors.has("portal")}
                    onSelect={handleNavSelect}
                  />
                  <NavItem
                    tab="mcp"
                    icon={<McpServerIcon className="w-4 h-4" />}
                    label="MCP Server"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.mcp}
                    hasError={tabsWithErrors.has("mcp")}
                    onSelect={handleNavSelect}
                  />
                </NavGroup>

                <NavGroup label="Support">
                  <NavItem
                    tab="troubleshooting"
                    icon={<LifeBuoy className="w-4 h-4" />}
                    label="Troubleshooting"
                    activeTab={activeTab}
                    isSearching={isSearching}
                    matchCount={matchCounts.troubleshooting}
                    hasError={tabsWithErrors.has("troubleshooting")}
                    onSelect={handleNavSelect}
                  />
                </NavGroup>
              </>
            ) : (
              <NavGroup label="Project">
                <NavItem
                  tab="project:general"
                  icon={<SettingsIcon className="w-4 h-4" />}
                  label="General"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:general"]}
                  hasError={tabsWithErrors.has("project:general")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:context"
                  icon={<FileCode className="w-4 h-4" />}
                  label="Context"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:context"]}
                  hasError={tabsWithErrors.has("project:context")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:variables"
                  icon={<KeyRound className="w-4 h-4" />}
                  label="Variables"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:variables"]}
                  hasError={tabsWithErrors.has("project:variables")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:automation"
                  icon={<GitBranch className="w-4 h-4" />}
                  label="Worktree Setup"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:automation"]}
                  hasError={tabsWithErrors.has("project:automation")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:recipes"
                  icon={<TerminalRecipeIcon className="w-4 h-4" />}
                  label="Recipes"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:recipes"]}
                  hasError={tabsWithErrors.has("project:recipes")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:commands"
                  icon={<Command className="w-4 h-4" />}
                  label="Commands"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:commands"]}
                  hasError={tabsWithErrors.has("project:commands")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:notifications"
                  icon={<Bell className="w-4 h-4" />}
                  label="Notifications"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:notifications"]}
                  hasError={tabsWithErrors.has("project:notifications")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="project:github"
                  icon={<Github className="w-4 h-4" />}
                  label="GitHub"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts["project:github"]}
                  hasError={tabsWithErrors.has("project:github")}
                  onSelect={handleNavSelect}
                />
              </NavGroup>
            )}
          </ScrollShadow>

          <div className="pt-2 mt-2 border-t border-daintree-border px-2">
            <span className="settings-meta font-mono">{appVersion}</span>
          </div>
        </div>

        <div className="settings-shell flex-1 flex flex-col min-w-0">
          <div className="dialog-header flex items-center justify-between px-6 py-4 border-b border-daintree-border shrink-0">
            <h3 className="text-lg font-medium text-daintree-text flex items-center gap-2">
              {isSearching ? (
                <>
                  <Search className="w-5 h-5 text-text-secondary" />
                  Search Results
                </>
              ) : (
                <>
                  {tabIcons[activeTab]}
                  {tabTitles[activeTab]}
                </>
              )}
            </h3>
            <button
              onClick={handleClose}
              className="text-daintree-text/60 hover:text-daintree-text transition-colors p-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
              aria-label="Close settings"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

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
                          {hiddenSettingBanner.label}
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
                <div
                  role="tabpanel"
                  id="settings-panel-general"
                  aria-labelledby="settings-tab-general"
                  tabIndex={0}
                  className={activeTab === "general" ? "" : "hidden"}
                >
                  <GeneralTab
                    appVersion={appVersion}
                    onNavigateToAgents={(agentId?: string) => {
                      markTabVisited("agents");
                      if (agentId) {
                        setActiveSubtabs((prev) => ({ ...prev, agents: agentId }));
                      }
                      startTransition(() => setActiveTab("agents"));
                    }}
                    activeSubtab={activeSubtabs["general"] ?? null}
                    onSubtabChange={(id) => setActiveSubtabs((prev) => ({ ...prev, general: id }))}
                  />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-keyboard"
                  aria-labelledby="settings-tab-keyboard"
                  tabIndex={0}
                  className={activeTab === "keyboard" ? "" : "hidden"}
                >
                  {visitedTabs.has("keyboard") && (
                    <Suspense fallback={null}>
                      <LazyKeyboardShortcutsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-terminal"
                  aria-labelledby="settings-tab-terminal"
                  tabIndex={0}
                  className={activeTab === "terminal" ? "" : "hidden"}
                >
                  {visitedTabs.has("terminal") && (
                    <Suspense fallback={null}>
                      <LazyTerminalSettingsTab
                        activeSubtab={activeSubtabs["terminal"] ?? null}
                        onSubtabChange={(id) =>
                          setActiveSubtabs((prev) => ({ ...prev, terminal: id }))
                        }
                      />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-terminalAppearance"
                  aria-labelledby="settings-tab-terminalAppearance"
                  tabIndex={0}
                  className={activeTab === "terminalAppearance" ? "" : "hidden"}
                >
                  {visitedTabs.has("terminalAppearance") && (
                    <Suspense fallback={null}>
                      <LazyTerminalAppearanceTab
                        activeSubtab={activeSubtabs["terminalAppearance"] ?? null}
                        onSubtabChange={(id) =>
                          setActiveSubtabs((prev) => ({ ...prev, terminalAppearance: id }))
                        }
                        onClose={handleClose}
                      />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-worktree"
                  aria-labelledby="settings-tab-worktree"
                  tabIndex={0}
                  className={activeTab === "worktree" ? "" : "hidden"}
                >
                  {visitedTabs.has("worktree") && (
                    <Suspense fallback={null}>
                      <LazyWorktreeSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-agents"
                  aria-labelledby="settings-tab-agents"
                  tabIndex={0}
                  className={activeTab === "agents" ? "" : "hidden"}
                >
                  {visitedTabs.has("agents") && (
                    <Suspense fallback={null}>
                      <LazyAgentSettings
                        activeSubtab={activeSubtabs["agents"] ?? null}
                        onSubtabChange={(id) =>
                          setActiveSubtabs((prev) => ({ ...prev, agents: id }))
                        }
                        onSettingsChange={onSettingsChange}
                      />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-github"
                  aria-labelledby="settings-tab-github"
                  tabIndex={0}
                  className={activeTab === "github" ? "" : "hidden"}
                >
                  {visitedTabs.has("github") && (
                    <Suspense fallback={null}>
                      <LazyGitHubSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-portal"
                  aria-labelledby="settings-tab-portal"
                  tabIndex={0}
                  className={activeTab === "portal" ? "" : "hidden"}
                >
                  {visitedTabs.has("portal") && (
                    <Suspense fallback={null}>
                      <LazyPortalSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-toolbar"
                  aria-labelledby="settings-tab-toolbar"
                  tabIndex={0}
                  className={activeTab === "toolbar" ? "" : "hidden"}
                >
                  {visitedTabs.has("toolbar") && (
                    <Suspense fallback={null}>
                      <LazyToolbarSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-notifications"
                  aria-labelledby="settings-tab-notifications"
                  tabIndex={0}
                  className={activeTab === "notifications" ? "" : "hidden"}
                >
                  {visitedTabs.has("notifications") && (
                    <Suspense fallback={null}>
                      <LazyNotificationSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-integrations"
                  aria-labelledby="settings-tab-integrations"
                  tabIndex={0}
                  className={activeTab === "integrations" ? "" : "hidden"}
                >
                  {visitedTabs.has("integrations") && (
                    <Suspense fallback={null}>
                      <LazyIntegrationsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-voice"
                  aria-labelledby="settings-tab-voice"
                  tabIndex={0}
                  className={activeTab === "voice" ? "" : "hidden"}
                >
                  {visitedTabs.has("voice") && (
                    <Suspense fallback={null}>
                      <LazyVoiceInputSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-mcp"
                  aria-labelledby="settings-tab-mcp"
                  tabIndex={0}
                  className={activeTab === "mcp" ? "" : "hidden"}
                >
                  {visitedTabs.has("mcp") && (
                    <Suspense fallback={null}>
                      <LazyMcpServerSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-environment"
                  aria-labelledby="settings-tab-environment"
                  tabIndex={0}
                  className={activeTab === "environment" ? "" : "hidden"}
                >
                  {visitedTabs.has("environment") && (
                    <Suspense fallback={null}>
                      <LazyEnvironmentSettingsTab />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-privacy"
                  aria-labelledby="settings-tab-privacy"
                  tabIndex={0}
                  className={activeTab === "privacy" ? "" : "hidden"}
                >
                  {visitedTabs.has("privacy") && (
                    <Suspense fallback={null}>
                      <LazyPrivacyDataTab
                        activeSubtab={activeSubtabs["privacy"] ?? null}
                        onSubtabChange={(id) =>
                          setActiveSubtabs((prev) => ({ ...prev, privacy: id }))
                        }
                      />
                    </Suspense>
                  )}
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-troubleshooting"
                  aria-labelledby="settings-tab-troubleshooting"
                  tabIndex={0}
                  className={activeTab === "troubleshooting" ? "" : "hidden"}
                >
                  {visitedTabs.has("troubleshooting") && (
                    <Suspense fallback={null}>
                      <LazyTroubleshootingTab />
                    </Suspense>
                  )}
                </div>

                {/* Project settings panels */}
                {activeScope === "project" && projectId && (
                  <>
                    {projectForm.projectIsLoading && (
                      <div className="text-sm text-daintree-text/60 text-center py-8">
                        Loading settings...
                      </div>
                    )}
                    {projectForm.projectError && (
                      <div
                        className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4"
                        role="alert"
                      >
                        Failed to load settings: {projectForm.projectError}
                      </div>
                    )}
                    {projectForm.projectAutoSaveError && (
                      <div
                        className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4"
                        role="alert"
                      >
                        {projectForm.projectAutoSaveError}
                      </div>
                    )}
                    {!projectForm.projectIsLoading && !projectForm.projectError && (
                      <>
                        <div
                          role="tabpanel"
                          id="settings-panel-project:general"
                          aria-labelledby="settings-tab-project:general"
                          tabIndex={0}
                          className={activeTab === "project:general" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:general") && (
                            <ProjectGeneralTab
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
                              projectIconSvg={projectForm.projectIconSvg}
                              onProjectIconSvgChange={projectForm.setProjectIconSvg}
                              enableInRepoSettings={projectForm.enableInRepoSettings}
                              disableInRepoSettings={projectForm.disableInRepoSettings}
                              projectId={projectId}
                              isOpen={isOpen}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:context"
                          aria-labelledby="settings-tab-project:context"
                          tabIndex={0}
                          className={activeTab === "project:context" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:context") && (
                            <ProjectContextTab
                              excludedPaths={projectForm.excludedPaths}
                              onExcludedPathsChange={projectForm.setExcludedPaths}
                              copyTreeSettings={projectForm.copyTreeSettings}
                              onCopyTreeSettingsChange={projectForm.setCopyTreeSettings}
                              worktrees={projectForm.worktrees}
                              isOpen={isOpen}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:variables"
                          aria-labelledby="settings-tab-project:variables"
                          tabIndex={0}
                          className={activeTab === "project:variables" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:variables") && (
                            <EnvironmentVariablesEditor
                              environmentVariables={projectForm.environmentVariables}
                              onEnvironmentVariablesChange={projectForm.setEnvironmentVariables}
                              settings={projectForm.projectSettings}
                              isOpen={isOpen}
                              onFlush={projectForm.flush}
                              projectLabel={projectLabel}
                              globalEnvironmentVariables={globalEnvVars}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:automation"
                          aria-labelledby="settings-tab-project:automation"
                          tabIndex={0}
                          className={activeTab === "project:automation" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:automation") && (
                            <ProjectAutomationTab
                              currentProject={projectForm.currentProject}
                              runCommands={projectForm.runCommands}
                              onRunCommandsChange={projectForm.setRunCommands}
                              defaultWorktreeRecipeId={projectForm.defaultWorktreeRecipeId}
                              onDefaultWorktreeRecipeIdChange={
                                projectForm.setDefaultWorktreeRecipeId
                              }
                              branchPrefixMode={projectForm.branchPrefixMode}
                              onBranchPrefixModeChange={projectForm.setBranchPrefixMode}
                              branchPrefixCustom={projectForm.branchPrefixCustom}
                              onBranchPrefixCustomChange={projectForm.setBranchPrefixCustom}
                              worktreePathPattern={projectForm.worktreePathPattern}
                              onWorktreePathPatternChange={projectForm.setWorktreePathPattern}
                              terminalShell={projectForm.terminalShell}
                              onTerminalShellChange={projectForm.setTerminalShell}
                              terminalShellArgs={projectForm.terminalShellArgs}
                              onTerminalShellArgsChange={projectForm.setTerminalShellArgs}
                              terminalDefaultCwd={projectForm.terminalDefaultCwd}
                              onTerminalDefaultCwdChange={projectForm.setTerminalDefaultCwd}
                              terminalScrollback={projectForm.terminalScrollback}
                              onTerminalScrollbackChange={projectForm.setTerminalScrollback}
                              recipes={projectForm.recipes}
                              recipesLoading={projectForm.recipesLoading}
                              onNavigateToRecipes={() => {
                                markTabVisited("project:recipes");
                                startTransition(() => setActiveTab("project:recipes"));
                              }}
                              resourceEnvironments={projectForm.resourceEnvironments}
                              onResourceEnvironmentsChange={projectForm.setResourceEnvironments}
                              activeResourceEnvironment={projectForm.activeResourceEnvironment}
                              onActiveResourceEnvironmentChange={
                                projectForm.setActiveResourceEnvironment
                              }
                              defaultWorktreeMode={projectForm.defaultWorktreeMode}
                              onDefaultWorktreeModeChange={projectForm.setDefaultWorktreeMode}
                              isOpen={isOpen}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:recipes"
                          aria-labelledby="settings-tab-project:recipes"
                          tabIndex={0}
                          className={activeTab === "project:recipes" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:recipes") && (
                            <ProjectRecipesTab
                              projectId={projectId}
                              defaultWorktreeRecipeId={projectForm.defaultWorktreeRecipeId}
                              onDefaultWorktreeRecipeIdChange={
                                projectForm.setDefaultWorktreeRecipeId
                              }
                              worktreeMap={projectForm.worktreeMap}
                              isOpen={isOpen}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:commands"
                          aria-labelledby="settings-tab-project:commands"
                          tabIndex={0}
                          className={activeTab === "project:commands" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:commands") && (
                            <CommandOverridesTab
                              projectId={projectId}
                              overrides={projectForm.commandOverrides}
                              onChange={projectForm.setCommandOverrides}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:notifications"
                          aria-labelledby="settings-tab-project:notifications"
                          tabIndex={0}
                          className={activeTab === "project:notifications" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:notifications") && (
                            <ProjectNotificationsTab
                              overrides={projectForm.notificationOverrides}
                              onChange={projectForm.setNotificationOverrides}
                            />
                          )}
                        </div>

                        <div
                          role="tabpanel"
                          id="settings-panel-project:github"
                          aria-labelledby="settings-tab-project:github"
                          tabIndex={0}
                          className={activeTab === "project:github" ? "" : "hidden"}
                        >
                          {visitedTabs.has("project:github") && projectForm.currentProject && (
                            <ProjectGitHubTab
                              githubRemote={projectForm.githubRemote}
                              onGithubRemoteChange={projectForm.setGithubRemote}
                              projectPath={projectForm.currentProject.path}
                            />
                          )}
                        </div>
                      </>
                    )}
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

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
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
}

function NavItem({
  tab,
  icon,
  label,
  activeTab,
  isSearching,
  matchCount,
  modified,
  hasError,
  onSelect,
}: NavItemProps) {
  const active = activeTab === tab && !isSearching;
  const selected = activeTab === tab;
  return (
    <button
      role="tab"
      id={`settings-tab-${tab}`}
      aria-selected={selected}
      aria-controls={`settings-panel-${tab}`}
      tabIndex={selected ? 0 : -1}
      data-tab={tab}
      onClick={() => onSelect(tab)}
      className={cn(
        "relative text-left px-3 py-1.5 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2 w-full",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
        "settings-nav-item",
        active
          ? "text-daintree-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
          : "text-text-secondary hover:text-daintree-text"
      )}
      data-active={active ? "true" : undefined}
    >
      <span className="relative">
        {icon}
        {(hasError || modified) && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full",
              hasError ? "bg-status-warning" : "bg-daintree-accent"
            )}
            title={hasError ? "Contains validation errors" : "Modified from default"}
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
      className="ml-auto text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-daintree-accent/20 text-daintree-accent leading-none"
    >
      {count}
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
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Search className="w-8 h-8 text-daintree-text/20 mb-3" />
        <p className="text-sm text-daintree-text/50">
          No results for <span className="font-medium text-daintree-text/70">"{query}"</span>
        </p>
        <p className="text-xs text-daintree-text/40 mt-1">
          {cleanQuery
            ? "Try different keywords or check spelling"
            : "No settings have been modified from their defaults"}
        </p>
      </div>
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
              ? "bg-overlay-soft border-daintree-accent/30"
              : "border-transparent hover:bg-overlay-soft hover:border-daintree-border",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-medium text-daintree-accent/80 uppercase tracking-wide">
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
                    Requires {result.requiresEnabled.label}
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
                "w-4 h-4 text-daintree-text/20 shrink-0 transition",
                index === activeIndex
                  ? "text-daintree-accent/60 translate-x-0.5"
                  : "group-hover:text-daintree-text/40"
              )}
            />
          </div>
        </button>
      ))}
    </div>
  );
}
