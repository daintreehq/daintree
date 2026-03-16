import {
  useState,
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  useSidecarStore,
  usePerformanceModeStore,
  useScrollbackStore,
  useLayoutConfigStore,
  useTerminalInputStore,
  useTwoPaneSplitStore,
  usePreferencesStore,
} from "@/store";
import {
  X,
  Waypoints,
  Code,
  Github,
  LayoutGrid,
  PanelRight,
  Keyboard,
  GitBranch,
  Terminal,
  Settings as SettingsIcon,
  Settings2,
  LifeBuoy,
  Bell,
  Mic,
  Plug,
  Image,
  Search,
  ChevronRight,
  KeyRound,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useVerticalScrollShadows } from "@/hooks/useVerticalScrollShadows";
import { appClient } from "@/clients";
import { AppDialog } from "@/components/ui/AppDialog";
import { AgentSettings } from "./AgentSettings";
import { GeneralTab } from "./GeneralTab";
import { TerminalSettingsTab } from "./TerminalSettingsTab";
import { TerminalAppearanceTab } from "./TerminalAppearanceTab";
import { GitHubSettingsTab } from "./GitHubSettingsTab";
import { TroubleshootingTab } from "./TroubleshootingTab";
import { NotificationSettingsTab } from "./NotificationSettingsTab";
import { SidecarSettingsTab } from "./SidecarSettingsTab";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab";
import { WorktreeSettingsTab } from "./WorktreeSettingsTab";
import { ToolbarSettingsTab } from "./ToolbarSettingsTab";
import { EditorIntegrationTab } from "./EditorIntegrationTab";
import { ImageViewerTab } from "./ImageViewerTab";
import { VoiceInputSettingsTab } from "./VoiceInputSettingsTab";
import { McpServerSettingsTab } from "./McpServerSettingsTab";
import { EnvironmentSettingsTab } from "./EnvironmentSettingsTab";
import { PrivacyDataTab } from "./PrivacyDataTab";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import {
  filterSettings,
  countMatchesPerTab,
  HighlightText,
  parseQuery,
} from "./settingsSearchUtils";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";

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
}

export type SettingsTab =
  | "general"
  | "keyboard"
  | "terminal"
  | "terminalAppearance"
  | "worktree"
  | "agents"
  | "github"
  | "sidecar"
  | "toolbar"
  | "notifications"
  | "editor"
  | "imageViewer"
  | "voice"
  | "mcp"
  | "environment"
  | "privacy"
  | "troubleshooting";

export function SettingsDialog({
  isOpen,
  onClose,
  defaultTab,
  defaultSubtab,
  defaultSectionId,
  onSettingsChange,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab ?? "general");
  const [activeSubtabs, setActiveSubtabs] = useState<Partial<Record<SettingsTab, string>>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const setSidecarOpen = useSidecarStore((state) => state.setOpen);

  useEffect(() => {
    if (isOpen) {
      setSidecarOpen(false);
    }
  }, [isOpen, setSidecarOpen]);

  const [appVersion, setAppVersion] = useState<string>("Loading...");

  useEffect(() => {
    if (isOpen && defaultTab) {
      if (defaultTab !== activeTab) {
        setActiveTab(defaultTab);
      }
      if (defaultSubtab !== undefined) {
        setActiveSubtabs((prev) => ({ ...prev, [defaultTab]: defaultSubtab }));
      }
      setScrollToSection(defaultSectionId ?? null);
      setSearchQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const modifiedTabs = useMemo(() => {
    const tabs = new Set<SettingsTab>();

    // General defaults: showProjectPulse=true, showDeveloperTools=false
    if (!showProjectPulse || showDeveloperTools) tabs.add("general");

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

    return tabs;
  }, [
    showProjectPulse,
    showDeveloperTools,
    performanceMode,
    scrollbackLines,
    layoutConfig.strategy,
    hybridInputEnabled,
    hybridInputAutoFocus,
    twoPaneSplitConfig.enabled,
    twoPaneSplitConfig.preferPreview,
    twoPaneSplitConfig.defaultRatio,
  ]);

  const searchResults = useMemo(
    () => filterSettings(SETTINGS_SEARCH_INDEX, deferredQuery, { modifiedTabs }),
    [deferredQuery, modifiedTabs]
  );

  const cleanSearchQuery = useMemo(() => parseQuery(deferredQuery).cleanQuery, [deferredQuery]);

  const matchCounts = useMemo(() => countMatchesPerTab(searchResults), [searchResults]);

  // Use live searchQuery for mode switching to avoid deferred split-brain;
  // deferredQuery drives the expensive filtering computation only.
  const isSearching = searchQuery.trim().length > 0;

  const handleResultClick = ({ tab, subtab, sectionId }: SettingsNavTarget) => {
    setActiveTab(tab);
    setSearchQuery("");
    setScrollToSection(sectionId ?? null);
    if (subtab !== undefined) {
      setActiveSubtabs((prev) => ({ ...prev, [tab]: subtab }));
    }
    searchInputRef.current?.blur();
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
        handleResultClick({ tab: result.tab, subtab: result.subtab, sectionId: result.id });
      }
    }
  };

  // Deep-link: scroll to a specific section after navigating
  const [scrollToSection, setScrollToSection] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollToSection || isSearching) return;
    let highlightTimer: ReturnType<typeof setTimeout>;
    const timer = setTimeout(() => {
      const el = document.getElementById(scrollToSection);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("settings-highlight");
        highlightTimer = setTimeout(() => el.classList.remove("settings-highlight"), 1500);
      }
    }, 100);
    return () => {
      clearTimeout(timer);
      clearTimeout(highlightTimer);
    };
  }, [scrollToSection, activeTab, isSearching]);

  const handleNavSelect = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    setSearchQuery("");
    setScrollToSection(null);
  }, []);

  const tablistRef = useRef<HTMLDivElement>(null);
  const { canScrollUp, canScrollDown } = useVerticalScrollShadows(tablistRef);

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
      tabs[nextIndex].focus();
      const tabId = tabs[nextIndex].dataset.tab as SettingsTab | undefined;
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
    sidecar: "Sidecar Links",
    toolbar: "Toolbar Customization",
    notifications: "Notifications",
    editor: "Editor Integration",
    imageViewer: "Image Viewer",
    voice: "Voice Input",
    mcp: "MCP Server",
    environment: "Environment Variables",
    privacy: "Privacy & Data",
    troubleshooting: "Troubleshooting",
  };

  const tabIcons: Record<SettingsTab, React.ReactNode> = {
    general: <Settings2 className="w-5 h-5 text-canopy-text/60" />,
    keyboard: <Keyboard className="w-5 h-5 text-canopy-text/60" />,
    terminal: <LayoutGrid className="w-5 h-5 text-canopy-text/60" />,
    terminalAppearance: <Terminal className="w-5 h-5 text-canopy-text/60" />,
    worktree: <GitBranch className="w-5 h-5 text-canopy-text/60" />,
    agents: <Waypoints className="w-5 h-5 text-canopy-text/60" />,
    github: <Github className="w-5 h-5 text-canopy-text/60" />,
    sidecar: <PanelRight className="w-5 h-5 text-canopy-text/60" />,
    toolbar: <SettingsIcon className="w-5 h-5 text-canopy-text/60" />,
    notifications: <Bell className="w-5 h-5 text-canopy-text/60" />,
    editor: <Code className="w-5 h-5 text-canopy-text/60" />,
    imageViewer: <Image className="w-5 h-5 text-canopy-text/60" />,
    voice: <Mic className="w-5 h-5 text-canopy-text/60" />,
    mcp: <Plug className="w-5 h-5 text-canopy-text/60" />,
    environment: <KeyRound className="w-5 h-5 text-canopy-text/60" />,
    privacy: <Shield className="w-5 h-5 text-canopy-text/60" />,
    troubleshooting: <LifeBuoy className="w-5 h-5 text-canopy-text/60" />,
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="4xl"
      maxHeight="h-[75vh]"
      className="min-h-[500px] max-h-[800px]"
    >
      <div className="flex h-full overflow-hidden">
        <div className="w-48 border-r border-canopy-border bg-canopy-bg/50 p-3 flex flex-col shrink-0">
          <h2 className="text-sm font-semibold text-canopy-text mb-2 px-2">Settings</h2>

          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 mb-2 rounded-[var(--radius-md)]",
              "bg-canopy-bg border border-canopy-border",
              "focus-within:border-canopy-accent focus-within:ring-1 focus-within:ring-canopy-accent/20"
            )}
          >
            <Search
              className="w-3.5 h-3.5 shrink-0 text-canopy-text/40 pointer-events-none"
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
              className="flex-1 min-w-0 text-xs bg-transparent text-canopy-text placeholder:text-text-muted focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="flex items-center justify-center w-5 h-5 rounded shrink-0 text-canopy-text/40 hover:text-canopy-text"
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

          <div className="relative flex-1 min-h-0 overflow-hidden">
            {canScrollUp && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-canopy-bg to-transparent z-10"
              />
            )}
            <div
              ref={tablistRef}
              role="tablist"
              aria-orientation="vertical"
              aria-label="Settings sections"
              onKeyDown={handleTablistKeyDown}
              className="h-full overflow-y-auto space-y-3"
            >
              <NavGroup label="General">
                <NavItem
                  tab="general"
                  icon={<Settings2 className="w-4 h-4" />}
                  label="General"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.general}
                  modified={modifiedTabs.has("general")}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="terminalAppearance"
                  icon={<Terminal className="w-4 h-4" />}
                  label="Appearance"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.terminalAppearance}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="keyboard"
                  icon={<Keyboard className="w-4 h-4" />}
                  label="Keyboard"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.keyboard}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="notifications"
                  icon={<Bell className="w-4 h-4" />}
                  label="Notifications"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.notifications}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="privacy"
                  icon={<Shield className="w-4 h-4" />}
                  label="Privacy & Data"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.privacy}
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
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="worktree"
                  icon={<GitBranch className="w-4 h-4" />}
                  label="Worktree"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.worktree}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="toolbar"
                  icon={<SettingsIcon className="w-4 h-4" />}
                  label="Toolbar"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.toolbar}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="environment"
                  icon={<KeyRound className="w-4 h-4" />}
                  label="Environment"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.environment}
                  onSelect={handleNavSelect}
                />
              </NavGroup>

              <NavGroup label="Integrations">
                <NavItem
                  tab="agents"
                  icon={<Waypoints className="w-4 h-4" />}
                  label="CLI Agents"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.agents}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="github"
                  icon={<Github className="w-4 h-4" />}
                  label="GitHub"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.github}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="editor"
                  icon={<Code className="w-4 h-4" />}
                  label="Editor"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.editor}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="imageViewer"
                  icon={<Image className="w-4 h-4" />}
                  label="Image Viewer"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.imageViewer}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="sidecar"
                  icon={<PanelRight className="w-4 h-4" />}
                  label="Sidecar"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.sidecar}
                  onSelect={handleNavSelect}
                />
                <NavItem
                  tab="mcp"
                  icon={<Plug className="w-4 h-4" />}
                  label="MCP Server"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.mcp}
                  onSelect={handleNavSelect}
                />
              </NavGroup>

              <NavGroup label="Input">
                <NavItem
                  tab="voice"
                  icon={<Mic className="w-4 h-4" />}
                  label="Voice Input"
                  activeTab={activeTab}
                  isSearching={isSearching}
                  matchCount={matchCounts.voice}
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
                  onSelect={handleNavSelect}
                />
              </NavGroup>
            </div>
            {canScrollDown && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-canopy-bg to-transparent z-10"
              />
            )}
          </div>

          <div className="pt-2 mt-2 border-t border-canopy-border px-2">
            <span className="text-[10px] text-canopy-text/30 font-mono">{appVersion}</span>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-canopy-border bg-canopy-sidebar/50 shrink-0">
            <h3 className="text-lg font-medium text-canopy-text flex items-center gap-2">
              {isSearching ? (
                <>
                  <Search className="w-5 h-5 text-canopy-text/60" />
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
              onClick={onClose}
              className="text-canopy-text/60 hover:text-canopy-text transition-colors p-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
              aria-label="Close settings"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto flex-1">
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
                <div
                  role="tabpanel"
                  id="settings-panel-general"
                  aria-labelledby="settings-tab-general"
                  tabIndex={0}
                  className={activeTab === "general" ? "" : "hidden"}
                >
                  <GeneralTab
                    appVersion={appVersion}
                    onNavigateToAgents={() => setActiveTab("agents")}
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
                  <KeyboardShortcutsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-terminal"
                  aria-labelledby="settings-tab-terminal"
                  tabIndex={0}
                  className={activeTab === "terminal" ? "" : "hidden"}
                >
                  <TerminalSettingsTab
                    activeSubtab={activeSubtabs["terminal"] ?? null}
                    onSubtabChange={(id) => setActiveSubtabs((prev) => ({ ...prev, terminal: id }))}
                  />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-terminalAppearance"
                  aria-labelledby="settings-tab-terminalAppearance"
                  tabIndex={0}
                  className={activeTab === "terminalAppearance" ? "" : "hidden"}
                >
                  <TerminalAppearanceTab
                    activeSubtab={activeSubtabs["terminalAppearance"] ?? null}
                    onSubtabChange={(id) =>
                      setActiveSubtabs((prev) => ({ ...prev, terminalAppearance: id }))
                    }
                  />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-worktree"
                  aria-labelledby="settings-tab-worktree"
                  tabIndex={0}
                  className={activeTab === "worktree" ? "" : "hidden"}
                >
                  <WorktreeSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-agents"
                  aria-labelledby="settings-tab-agents"
                  tabIndex={0}
                  className={activeTab === "agents" ? "" : "hidden"}
                >
                  <AgentSettings
                    activeSubtab={activeSubtabs["agents"] ?? null}
                    onSubtabChange={(id) => setActiveSubtabs((prev) => ({ ...prev, agents: id }))}
                    onSettingsChange={onSettingsChange}
                  />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-github"
                  aria-labelledby="settings-tab-github"
                  tabIndex={0}
                  className={activeTab === "github" ? "" : "hidden"}
                >
                  <GitHubSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-sidecar"
                  aria-labelledby="settings-tab-sidecar"
                  tabIndex={0}
                  className={activeTab === "sidecar" ? "" : "hidden"}
                >
                  <SidecarSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-toolbar"
                  aria-labelledby="settings-tab-toolbar"
                  tabIndex={0}
                  className={activeTab === "toolbar" ? "" : "hidden"}
                >
                  <ToolbarSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-notifications"
                  aria-labelledby="settings-tab-notifications"
                  tabIndex={0}
                  className={activeTab === "notifications" ? "" : "hidden"}
                >
                  <NotificationSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-editor"
                  aria-labelledby="settings-tab-editor"
                  tabIndex={0}
                  className={activeTab === "editor" ? "" : "hidden"}
                >
                  <EditorIntegrationTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-imageViewer"
                  aria-labelledby="settings-tab-imageViewer"
                  tabIndex={0}
                  className={activeTab === "imageViewer" ? "" : "hidden"}
                >
                  <ImageViewerTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-voice"
                  aria-labelledby="settings-tab-voice"
                  tabIndex={0}
                  className={activeTab === "voice" ? "" : "hidden"}
                >
                  <VoiceInputSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-mcp"
                  aria-labelledby="settings-tab-mcp"
                  tabIndex={0}
                  className={activeTab === "mcp" ? "" : "hidden"}
                >
                  <McpServerSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-environment"
                  aria-labelledby="settings-tab-environment"
                  tabIndex={0}
                  className={activeTab === "environment" ? "" : "hidden"}
                >
                  <EnvironmentSettingsTab />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-privacy"
                  aria-labelledby="settings-tab-privacy"
                  tabIndex={0}
                  className={activeTab === "privacy" ? "" : "hidden"}
                >
                  <PrivacyDataTab
                    activeSubtab={activeSubtabs["privacy"] ?? null}
                    onSubtabChange={(id) => setActiveSubtabs((prev) => ({ ...prev, privacy: id }))}
                  />
                </div>

                <div
                  role="tabpanel"
                  id="settings-panel-troubleshooting"
                  aria-labelledby="settings-tab-troubleshooting"
                  tabIndex={0}
                  className={activeTab === "troubleshooting" ? "" : "hidden"}
                >
                  <TroubleshootingTab />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </AppDialog>
  );
}

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="none">
      <span
        className="text-[10px] font-medium uppercase tracking-wider text-canopy-text/30 px-3 mb-1 block select-none"
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
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
        active
          ? "bg-overlay-soft text-canopy-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "text-canopy-text/60 hover:bg-overlay-soft hover:text-canopy-text"
      )}
    >
      <span className="relative">
        {icon}
        {modified && (
          <span
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-canopy-accent"
            title="Modified from default"
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
      className="ml-auto text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent leading-none"
    >
      {count}
    </span>
  );
}

interface SearchResultsProps {
  results: ReturnType<typeof filterSettings>;
  query: string;
  cleanQuery: string;
  onResultClick: (target: SettingsNavTarget) => void;
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
        <Search className="w-8 h-8 text-canopy-text/20 mb-3" />
        <p className="text-sm text-canopy-text/50">
          No results for <span className="font-medium text-canopy-text/70">"{query}"</span>
        </p>
        <p className="text-xs text-canopy-text/40 mt-1">
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
        <p className="text-xs text-canopy-text/40">
          {results.length} result{results.length === 1 ? "" : "s"}
        </p>
        <p className="text-[10px] text-canopy-text/30">
          <kbd className="px-1 py-0.5 rounded bg-canopy-bg border border-canopy-border font-mono">
            ↑↓
          </kbd>{" "}
          navigate{" "}
          <kbd className="px-1 py-0.5 rounded bg-canopy-bg border border-canopy-border font-mono">
            ↵
          </kbd>{" "}
          go
        </p>
      </div>
      {results.map((result, index) => (
        <button
          key={result.id}
          ref={index === activeIndex ? activeRef : undefined}
          onClick={() =>
            onResultClick({ tab: result.tab, subtab: result.subtab, sectionId: result.id })
          }
          className={cn(
            "group w-full text-left p-3 rounded-[var(--radius-md)] border transition-all",
            index === activeIndex
              ? "bg-overlay-soft border-canopy-accent/30"
              : "border-transparent hover:bg-overlay-soft hover:border-canopy-border",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
          )}
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-medium text-canopy-accent/80 uppercase tracking-wide">
                  {result.tabLabel}
                </span>
                {result.subtabLabel && (
                  <>
                    <span className="text-[10px] text-canopy-text/30">›</span>
                    <span className="text-[10px] text-canopy-text/50">{result.subtabLabel}</span>
                  </>
                )}
                <span className="text-[10px] text-canopy-text/30">›</span>
                <span className="text-[10px] text-canopy-text/50">{result.section}</span>
              </div>
              <div className="text-sm font-medium text-canopy-text">
                <HighlightText text={result.title} query={query} />
              </div>
              <div className="text-xs text-canopy-text/50 mt-0.5 leading-relaxed">
                <HighlightText text={result.description} query={query} />
              </div>
            </div>
            <ChevronRight
              className={cn(
                "w-4 h-4 text-canopy-text/20 shrink-0 transition-all",
                index === activeIndex
                  ? "text-canopy-accent/60 translate-x-0.5"
                  : "group-hover:text-canopy-text/40"
              )}
            />
          </div>
        </button>
      ))}
    </div>
  );
}
