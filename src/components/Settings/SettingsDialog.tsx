import { useState, useEffect, useDeferredValue, useMemo, useRef } from "react";
import { useSidecarStore } from "@/store";
import {
  X,
  Bot,
  Code,
  Github,
  LayoutGrid,
  PanelRight,
  Keyboard,
  GitBranch,
  Terminal,
  Settings as SettingsIcon,
  Bell,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import { filterSettings, countMatchesPerTab, HighlightText } from "./settingsSearchUtils";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: SettingsTab;
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
  | "troubleshooting";

export function SettingsDialog({
  isOpen,
  onClose,
  defaultTab,
  onSettingsChange,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(defaultTab ?? "general");
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
    if (isOpen && defaultTab && defaultTab !== activeTab) {
      setActiveTab(defaultTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultTab]);

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

  const searchResults = useMemo(
    () => filterSettings(SETTINGS_SEARCH_INDEX, deferredQuery),
    [deferredQuery]
  );

  const matchCounts = useMemo(() => countMatchesPerTab(searchResults), [searchResults]);

  // Use live searchQuery for mode switching to avoid deferred split-brain;
  // deferredQuery drives the expensive filtering computation only.
  const isSearching = searchQuery.trim().length > 0;

  const handleResultClick = (tab: SettingsTab) => {
    setActiveTab(tab);
    setSearchQuery("");
    searchInputRef.current?.blur();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (searchQuery) {
        e.stopPropagation();
        setSearchQuery("");
        searchInputRef.current?.blur();
      }
    }
  };

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
    troubleshooting: "Troubleshooting",
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
        <div className="w-48 border-r border-canopy-border bg-canopy-bg/50 p-3 flex flex-col gap-1 shrink-0">
          <h2 className="text-sm font-semibold text-canopy-text mb-2 px-2">Settings</h2>

          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-canopy-text/40 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label="Search settings"
              className={cn(
                "w-full pl-7 pr-6 py-1.5 text-xs rounded-[var(--radius-md)] border transition-colors",
                "bg-canopy-bg border-canopy-border text-canopy-text placeholder:text-canopy-text/40",
                "focus:outline-none focus:border-canopy-accent"
              )}
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text transition-colors"
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

          <NavButton
            active={activeTab === "general" && !isSearching}
            onClick={() => {
              setActiveTab("general");
              setSearchQuery("");
            }}
          >
            <span className="flex-1">General</span>
            {matchCounts.general ? <MatchBadge count={matchCounts.general} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "keyboard" && !isSearching}
            onClick={() => {
              setActiveTab("keyboard");
              setSearchQuery("");
            }}
            icon={<Keyboard className="w-4 h-4" />}
          >
            <span className="flex-1">Keyboard</span>
            {matchCounts.keyboard ? <MatchBadge count={matchCounts.keyboard} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "terminal" && !isSearching}
            onClick={() => {
              setActiveTab("terminal");
              setSearchQuery("");
            }}
            icon={<LayoutGrid className="w-4 h-4" />}
          >
            <span className="flex-1">Terminal</span>
            {matchCounts.terminal ? <MatchBadge count={matchCounts.terminal} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "terminalAppearance" && !isSearching}
            onClick={() => {
              setActiveTab("terminalAppearance");
              setSearchQuery("");
            }}
            icon={<Terminal className="w-4 h-4" />}
          >
            <span className="flex-1">Appearance</span>
            {matchCounts.terminalAppearance ? (
              <MatchBadge count={matchCounts.terminalAppearance} />
            ) : null}
          </NavButton>
          <NavButton
            active={activeTab === "worktree" && !isSearching}
            onClick={() => {
              setActiveTab("worktree");
              setSearchQuery("");
            }}
            icon={<GitBranch className="w-4 h-4" />}
          >
            <span className="flex-1">Worktree</span>
            {matchCounts.worktree ? <MatchBadge count={matchCounts.worktree} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "agents" && !isSearching}
            onClick={() => {
              setActiveTab("agents");
              setSearchQuery("");
            }}
            icon={<Bot className="w-4 h-4" />}
          >
            <span className="flex-1">CLI Agents</span>
            {matchCounts.agents ? <MatchBadge count={matchCounts.agents} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "github" && !isSearching}
            onClick={() => {
              setActiveTab("github");
              setSearchQuery("");
            }}
            icon={<Github className="w-4 h-4" />}
          >
            <span className="flex-1">GitHub</span>
            {matchCounts.github ? <MatchBadge count={matchCounts.github} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "sidecar" && !isSearching}
            onClick={() => {
              setActiveTab("sidecar");
              setSearchQuery("");
            }}
            icon={<PanelRight className="w-4 h-4" />}
          >
            <span className="flex-1">Sidecar</span>
            {matchCounts.sidecar ? <MatchBadge count={matchCounts.sidecar} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "toolbar" && !isSearching}
            onClick={() => {
              setActiveTab("toolbar");
              setSearchQuery("");
            }}
            icon={<SettingsIcon className="w-4 h-4" />}
          >
            <span className="flex-1">Toolbar</span>
            {matchCounts.toolbar ? <MatchBadge count={matchCounts.toolbar} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "notifications" && !isSearching}
            onClick={() => {
              setActiveTab("notifications");
              setSearchQuery("");
            }}
            icon={<Bell className="w-4 h-4" />}
          >
            <span className="flex-1">Notifications</span>
            {matchCounts.notifications ? <MatchBadge count={matchCounts.notifications} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "editor" && !isSearching}
            onClick={() => {
              setActiveTab("editor");
              setSearchQuery("");
            }}
            icon={<Code className="w-4 h-4" />}
          >
            <span className="flex-1">Editor</span>
            {matchCounts.editor ? <MatchBadge count={matchCounts.editor} /> : null}
          </NavButton>
          <NavButton
            active={activeTab === "troubleshooting" && !isSearching}
            onClick={() => {
              setActiveTab("troubleshooting");
              setSearchQuery("");
            }}
          >
            <span className="flex-1">Troubleshooting</span>
            {matchCounts.troubleshooting ? (
              <MatchBadge count={matchCounts.troubleshooting} />
            ) : null}
          </NavButton>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-canopy-border bg-canopy-sidebar/50 shrink-0">
            <h3 className="text-lg font-medium text-canopy-text">
              {isSearching ? "Search Results" : tabTitles[activeTab]}
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
              <SearchResults
                results={searchResults}
                query={deferredQuery}
                onResultClick={handleResultClick}
              />
            ) : (
              <>
                <div className={activeTab === "general" ? "" : "hidden"}>
                  <GeneralTab
                    appVersion={appVersion}
                    onNavigateToAgents={() => setActiveTab("agents")}
                  />
                </div>

                <div className={activeTab === "keyboard" ? "" : "hidden"}>
                  <KeyboardShortcutsTab />
                </div>

                <div className={activeTab === "terminal" ? "" : "hidden"}>
                  <TerminalSettingsTab />
                </div>

                <div className={activeTab === "terminalAppearance" ? "" : "hidden"}>
                  <TerminalAppearanceTab />
                </div>

                <div className={activeTab === "worktree" ? "" : "hidden"}>
                  <WorktreeSettingsTab />
                </div>

                <div className={activeTab === "agents" ? "" : "hidden"}>
                  <AgentSettings onSettingsChange={onSettingsChange} />
                </div>

                <div className={activeTab === "github" ? "" : "hidden"}>
                  <GitHubSettingsTab />
                </div>

                <div className={activeTab === "sidecar" ? "" : "hidden"}>
                  <SidecarSettingsTab />
                </div>

                <div className={activeTab === "toolbar" ? "" : "hidden"}>
                  <ToolbarSettingsTab />
                </div>

                <div className={activeTab === "notifications" ? "" : "hidden"}>
                  <NotificationSettingsTab />
                </div>

                <div className={activeTab === "editor" ? "" : "hidden"}>
                  <EditorIntegrationTab />
                </div>

                <div className={activeTab === "troubleshooting" ? "" : "hidden"}>
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

interface NavButtonProps {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function NavButton({ active, onClick, icon, children }: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2 w-full",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
        active
          ? "bg-overlay-soft text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "text-canopy-text/60 hover:bg-overlay-soft hover:text-canopy-text"
      )}
    >
      {icon}
      {children}
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
  onResultClick: (tab: SettingsTab) => void;
}

function SearchResults({ results, query, onResultClick }: SearchResultsProps) {
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Search className="w-8 h-8 text-canopy-text/20 mb-3" />
        <p className="text-sm text-canopy-text/50">
          No results for <span className="font-medium text-canopy-text/70">"{query}"</span>
        </p>
        <p className="text-xs text-canopy-text/40 mt-1">Try a different keyword</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-canopy-text/40 mb-3">
        {results.length} result{results.length === 1 ? "" : "s"}
      </p>
      {results.map((result) => (
        <button
          key={result.id}
          onClick={() => onResultClick(result.tab)}
          className={cn(
            "w-full text-left p-3 rounded-[var(--radius-md)] border border-transparent transition-all",
            "hover:bg-overlay-soft hover:border-canopy-border",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
          )}
        >
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-medium text-canopy-accent/80 uppercase tracking-wide">
                  {result.tabLabel}
                </span>
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
          </div>
        </button>
      ))}
    </div>
  );
}
