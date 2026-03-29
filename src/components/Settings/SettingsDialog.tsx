import {
  Suspense,
  lazy,
  startTransition,
  useState,
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useCallback,
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
} from "@/store";
import {
  X,
  Blocks,
  Github,
  LayoutGrid,
  PanelRight,
  Keyboard,
  SquareTerminal,
  Settings as SettingsIcon,
  Settings2,
  LifeBuoy,
  Bell,
  Mic,
  Plug,
  Search,
  ChevronRight,
  KeyRound,
  Shield,
  FileCode,
  Zap,
  Command,
  CookingPot,
} from "lucide-react";
import { WorktreeIcon, CanopyAgentIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useVerticalScrollShadows } from "@/hooks/useVerticalScrollShadows";
import { appClient } from "@/clients";
import { AppDialog } from "@/components/ui/AppDialog";
import { GeneralTab } from "./GeneralTab";
const LazyAgentSettings = lazy(() =>
  import("./AgentSettings").then((m) => ({ default: m.AgentSettings }))
);
const LazyTerminalSettingsTab = lazy(() =>
  import("./TerminalSettingsTab").then((m) => ({ default: m.TerminalSettingsTab }))
);
const LazyTerminalAppearanceTab = lazy(() =>
  import("./TerminalAppearanceTab").then((m) => ({ default: m.TerminalAppearanceTab }))
);
const LazyGitHubSettingsTab = lazy(() =>
  import("./GitHubSettingsTab").then((m) => ({ default: m.GitHubSettingsTab }))
);
const LazyTroubleshootingTab = lazy(() =>
  import("./TroubleshootingTab").then((m) => ({ default: m.TroubleshootingTab }))
);
const LazyNotificationSettingsTab = lazy(() =>
  import("./NotificationSettingsTab").then((m) => ({ default: m.NotificationSettingsTab }))
);
const LazyPortalSettingsTab = lazy(() =>
  import("./PortalSettingsTab").then((m) => ({ default: m.PortalSettingsTab }))
);
const LazyKeyboardShortcutsTab = lazy(() =>
  import("./KeyboardShortcutsTab").then((m) => ({ default: m.KeyboardShortcutsTab }))
);
const LazyWorktreeSettingsTab = lazy(() =>
  import("./WorktreeSettingsTab").then((m) => ({ default: m.WorktreeSettingsTab }))
);
const LazyToolbarSettingsTab = lazy(() =>
  import("./ToolbarSettingsTab").then((m) => ({ default: m.ToolbarSettingsTab }))
);
const LazyIntegrationsTab = lazy(() =>
  import("./IntegrationsTab").then((m) => ({ default: m.IntegrationsTab }))
);
const LazyVoiceInputSettingsTab = lazy(() =>
  import("./VoiceInputSettingsTab").then((m) => ({ default: m.VoiceInputSettingsTab }))
);
const LazyMcpServerSettingsTab = lazy(() =>
  import("./McpServerSettingsTab").then((m) => ({ default: m.McpServerSettingsTab }))
);
const LazyEnvironmentSettingsTab = lazy(() =>
  import("./EnvironmentSettingsTab").then((m) => ({ default: m.EnvironmentSettingsTab }))
);
const LazyPrivacyDataTab = lazy(() =>
  import("./PrivacyDataTab").then((m) => ({ default: m.PrivacyDataTab }))
);
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import {
  filterSettings,
  countMatchesPerTab,
  HighlightText,
  parseQuery,
} from "./settingsSearchUtils";
import { SCROLLBACK_DEFAULT } from "@shared/config/scrollback";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import { useProjectSettings } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useRecipeStore } from "@/store/recipeStore";
import { debounce } from "@/utils/debounce";
import {
  createProjectSettingsSnapshot,
  areSnapshotsEqual,
  type EnvVar,
} from "@/components/Project/projectSettingsDirty";
import { validatePathPattern } from "@shared/utils/pathPattern";
import type { RunCommand, CopyTreeSettings } from "@/types";
import type { ProjectTerminalSettings } from "@shared/types/project";
import type { CommandOverride } from "@shared/types/commands";
import type { NotificationSettings } from "@shared/types/ipc/api";
import { GeneralTab as ProjectGeneralTab } from "@/components/Project/GeneralTab";
import { ContextTab as ProjectContextTab } from "@/components/Project/ContextTab";
import { AutomationTab as ProjectAutomationTab } from "@/components/Project/AutomationTab";
import { RecipesTab as ProjectRecipesTab } from "@/components/Project/RecipesTab";
import { CommandOverridesTab } from "./CommandOverridesTab";
import { ProjectNotificationsTab } from "@/components/Project/ProjectNotificationsTab";

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
  | "project:automation"
  | "project:recipes"
  | "project:commands"
  | "project:notifications";

export type SettingsScope = "global" | "project";

function scopeForTab(tab: SettingsTab): SettingsScope {
  return tab.startsWith("project:") ? "project" : "global";
}

export function SettingsDialog({
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

  useEffect(() => {
    if (isOpen) {
      setPortalOpen(false);
    }
  }, [isOpen, setPortalOpen]);

  const [appVersion, setAppVersion] = useState<string>("Loading...");

  useEffect(() => {
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
  const showGridAgentHighlights = usePreferencesStore((s) => s.showGridAgentHighlights);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);

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

    return tabs;
  }, [
    showProjectPulse,
    showDeveloperTools,
    showGridAgentHighlights,
    showDockAgentHighlights,
    performanceMode,
    scrollbackLines,
    layoutConfig.strategy,
    hybridInputEnabled,
    hybridInputAutoFocus,
    twoPaneSplitConfig.enabled,
    twoPaneSplitConfig.preferPreview,
    twoPaneSplitConfig.defaultRatio,
  ]);

  // ── Project settings state machine ──
  const { settings: projectSettings, saveSettings: saveProjectSettings, isLoading: projectIsLoading, error: projectError } = useProjectSettings(projectId ?? "");
  const { projects, updateProject, enableInRepoSettings, disableInRepoSettings } = useProjectStore();
  const currentProject = projectId ? projects.find((p) => p.id === projectId) : undefined;

  const [projectAutoSaveError, setProjectAutoSaveError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectEmoji, setProjectEmoji] = useState("🌲");
  const [projectColor, setProjectColor] = useState<string | undefined>(undefined);
  const [runCommands, setRunCommands] = useState<RunCommand[]>([]);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvVar[]>([]);
  const [excludedPaths, setExcludedPaths] = useState<string[]>([]);
  const [projectIsInitialized, setProjectIsInitialized] = useState(false);
  const [projectIconSvg, setProjectIconSvg] = useState<string | undefined>(undefined);
  const [defaultWorktreeRecipeId, setDefaultWorktreeRecipeId] = useState<string | undefined>(undefined);
  const [devServerCommand, setDevServerCommand] = useState<string>("");
  const [devServerLoadTimeout, setDevServerLoadTimeout] = useState<number | undefined>(undefined);
  const [commandOverrides, setCommandOverrides] = useState<CommandOverride[]>([]);
  const [copyTreeSettings, setCopyTreeSettings] = useState<CopyTreeSettings>({});
  const [branchPrefixMode, setBranchPrefixMode] = useState<"none" | "username" | "custom">("none");
  const [branchPrefixCustom, setBranchPrefixCustom] = useState<string>("");
  const [worktreePathPattern, setWorktreePathPattern] = useState<string>("");
  const [terminalShell, setTerminalShell] = useState<string>("");
  const [terminalShellArgs, setTerminalShellArgs] = useState<string>("");
  const [terminalDefaultCwd, setTerminalDefaultCwd] = useState<string>("");
  const [terminalScrollback, setTerminalScrollback] = useState<string>("");
  const [notificationOverrides, setNotificationOverrides] = useState<Partial<NotificationSettings>>({});
  const lastSavedSnapshotRef = useRef<ReturnType<typeof createProjectSettingsSnapshot> | null>(null);

  const { recipes, isLoading: recipesLoading } = useRecipeStore();
  const { worktreeMap, worktrees } = useWorktrees();

  const currentTerminalSettings = useMemo((): ProjectTerminalSettings | undefined => {
    const result: ProjectTerminalSettings = {};
    if (terminalShell.trim()) result.shell = terminalShell.trim();
    if (terminalShellArgs.trim()) result.shellArgs = terminalShellArgs.trim().split(/\s+/);
    if (terminalDefaultCwd.trim()) result.defaultWorkingDirectory = terminalDefaultCwd.trim();
    if (terminalScrollback.trim()) {
      const num = Number(terminalScrollback);
      if (Number.isFinite(num) && num >= SCROLLBACK_MIN && num <= SCROLLBACK_MAX) {
        result.scrollbackLines = Math.trunc(num);
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }, [terminalShell, terminalShellArgs, terminalDefaultCwd, terminalScrollback]);

  const currentProjectSnapshot = useMemo(() => {
    if (!currentProject) return null;
    return createProjectSettingsSnapshot(
      projectName, projectEmoji, devServerCommand, projectIconSvg, excludedPaths,
      environmentVariables, runCommands, defaultWorktreeRecipeId, commandOverrides,
      copyTreeSettings, branchPrefixMode, branchPrefixCustom, devServerLoadTimeout,
      worktreePathPattern, currentTerminalSettings, notificationOverrides, projectColor
    );
  }, [
    projectName, projectEmoji, projectColor, devServerCommand, devServerLoadTimeout,
    projectIconSvg, excludedPaths, environmentVariables, runCommands, defaultWorktreeRecipeId,
    commandOverrides, copyTreeSettings, branchPrefixMode, branchPrefixCustom,
    worktreePathPattern, currentProject, currentTerminalSettings, notificationOverrides,
  ]);

  useEffect(() => {
    if (isOpen && !projectIsLoading && projectSettings && currentProject && !projectIsInitialized) {
      const initialRunCommands = projectSettings.runCommands || [];
      const envVars = projectSettings.environmentVariables || {};
      const initialEnvVars = Object.entries(envVars).map(([key, value]) => ({
        id: `env-${Date.now()}-${Math.random()}`,
        key,
        value,
      }));
      const initialExcludedPaths = projectSettings.excludedPaths || [];
      const initialProjectIconSvg = projectSettings.projectIconSvg;
      const initialDefaultWorktreeRecipeId = projectSettings.defaultWorktreeRecipeId;
      const initialDevServerCommand = projectSettings.devServerCommand || "";
      const initialDevServerLoadTimeout = projectSettings.devServerLoadTimeout;
      const initialCommandOverrides = projectSettings.commandOverrides || [];
      const initialCopyTreeSettings = projectSettings.copyTreeSettings || {};
      const initialBranchPrefixMode = projectSettings.branchPrefixMode ?? "none";
      const initialBranchPrefixCustom = projectSettings.branchPrefixCustom ?? "";
      const initialWorktreePathPattern = projectSettings.worktreePathPattern ?? "";
      const initialTerminalSettings = projectSettings.terminalSettings;
      const initialNotificationOverrides = projectSettings.notificationOverrides ?? {};

      setProjectName(currentProject.name);
      setProjectEmoji(currentProject.emoji || "🌲");
      setProjectColor(currentProject.color);
      setRunCommands(initialRunCommands);
      setEnvironmentVariables(initialEnvVars);
      setExcludedPaths(initialExcludedPaths);
      setProjectIconSvg(initialProjectIconSvg);
      setDefaultWorktreeRecipeId(initialDefaultWorktreeRecipeId);
      setDevServerCommand(initialDevServerCommand);
      setDevServerLoadTimeout(initialDevServerLoadTimeout);
      setCommandOverrides(initialCommandOverrides);
      setCopyTreeSettings(initialCopyTreeSettings);
      setBranchPrefixMode(initialBranchPrefixMode);
      setBranchPrefixCustom(initialBranchPrefixCustom);
      setWorktreePathPattern(initialWorktreePathPattern);
      setTerminalShell(initialTerminalSettings?.shell ?? "");
      setTerminalShellArgs(initialTerminalSettings?.shellArgs?.join(" ") ?? "");
      setTerminalDefaultCwd(initialTerminalSettings?.defaultWorkingDirectory ?? "");
      setTerminalScrollback(
        initialTerminalSettings?.scrollbackLines !== undefined
          ? String(initialTerminalSettings.scrollbackLines)
          : ""
      );
      setNotificationOverrides(initialNotificationOverrides);

      lastSavedSnapshotRef.current = createProjectSettingsSnapshot(
        currentProject.name, currentProject.emoji || "🌲", initialDevServerCommand,
        initialProjectIconSvg, initialExcludedPaths, initialEnvVars, initialRunCommands,
        initialDefaultWorktreeRecipeId, initialCommandOverrides, initialCopyTreeSettings,
        initialBranchPrefixMode, initialBranchPrefixCustom, initialDevServerLoadTimeout,
        initialWorktreePathPattern, initialTerminalSettings, initialNotificationOverrides,
        currentProject.color
      );
      setProjectIsInitialized(true);
    }
    if (!isOpen) {
      setProjectIsInitialized(false);
      setEnvironmentVariables([]);
      setProjectIconSvg(undefined);
      setDefaultWorktreeRecipeId(undefined);
      setDevServerCommand("");
      setDevServerLoadTimeout(undefined);
      setCommandOverrides([]);
      setCopyTreeSettings({});
      setProjectAutoSaveError(null);
      setProjectColor(undefined);
      setBranchPrefixMode("none");
      setBranchPrefixCustom("");
      setWorktreePathPattern("");
      setTerminalShell("");
      setTerminalShellArgs("");
      setTerminalDefaultCwd("");
      setTerminalScrollback("");
      setNotificationOverrides({});
      lastSavedSnapshotRef.current = null;
    }
  }, [projectSettings, isOpen, projectIsInitialized, currentProject, projectIsLoading]);

  useEffect(() => {
    if (isOpen) {
      setProjectIsInitialized(false);
    }
  }, [projectId, isOpen]);

  const projectPersistRef = useRef<() => Promise<void>>(undefined);
  projectPersistRef.current = async () => {
    if (!projectSettings || !currentProject || !projectId) return;

    const sanitizedRunCommands = runCommands
      .map((cmd) => ({ ...cmd, name: cmd.name.trim(), command: cmd.command.trim() }))
      .filter((cmd) => cmd.name && cmd.command);

    const envVarRecord: Record<string, string> = {};
    const seenKeys = new Set<string>();
    for (const envVar of environmentVariables) {
      const trimmedKey = envVar.key.trim();
      if (!trimmedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey) || seenKeys.has(trimmedKey)) continue;
      seenKeys.add(trimmedKey);
      envVarRecord[trimmedKey] = envVar.value;
    }

    const sanitizedPaths = excludedPaths.map((p) => p.trim()).filter(Boolean);
    const sanitizedCopyTreeSettings: CopyTreeSettings = {};
    if (copyTreeSettings.maxContextSize !== undefined) sanitizedCopyTreeSettings.maxContextSize = copyTreeSettings.maxContextSize;
    if (copyTreeSettings.maxFileSize !== undefined) sanitizedCopyTreeSettings.maxFileSize = copyTreeSettings.maxFileSize;
    if (copyTreeSettings.charLimit !== undefined) sanitizedCopyTreeSettings.charLimit = copyTreeSettings.charLimit;
    if (copyTreeSettings.strategy) sanitizedCopyTreeSettings.strategy = copyTreeSettings.strategy;
    if (copyTreeSettings.alwaysInclude && copyTreeSettings.alwaysInclude.length > 0) {
      sanitizedCopyTreeSettings.alwaysInclude = copyTreeSettings.alwaysInclude.map((p) => p.trim()).filter(Boolean);
      if (sanitizedCopyTreeSettings.alwaysInclude.length === 0) delete sanitizedCopyTreeSettings.alwaysInclude;
    }
    if (copyTreeSettings.alwaysExclude && copyTreeSettings.alwaysExclude.length > 0) {
      sanitizedCopyTreeSettings.alwaysExclude = copyTreeSettings.alwaysExclude.map((p) => p.trim()).filter(Boolean);
      if (sanitizedCopyTreeSettings.alwaysExclude.length === 0) delete sanitizedCopyTreeSettings.alwaysExclude;
    }
    const hasCopyTreeSettings = Object.keys(sanitizedCopyTreeSettings).length > 0;

    const sanitizedBranchPrefixCustom = branchPrefixCustom.trim();
    const effectivePrefixMode = branchPrefixMode === "custom" && !sanitizedBranchPrefixCustom ? "none" : branchPrefixMode;
    const sanitizedWorktreePathPattern = worktreePathPattern.trim() || undefined;
    if (sanitizedWorktreePathPattern) {
      const patternValidation = validatePathPattern(sanitizedWorktreePathPattern);
      if (!patternValidation.valid) return;
    }

    setProjectAutoSaveError(null);
    try {
      const trimmedName = projectName.trim() || currentProject.name;
      const identityChanged =
        trimmedName !== currentProject.name ||
        projectEmoji !== (currentProject.emoji || "🌲") ||
        projectColor !== currentProject.color;
      if (identityChanged) {
        await updateProject(projectId, { name: trimmedName, emoji: projectEmoji, color: projectColor });
      }

      await saveProjectSettings({
        ...projectSettings,
        runCommands: sanitizedRunCommands,
        environmentVariables: Object.keys(envVarRecord).length > 0 ? envVarRecord : undefined,
        excludedPaths: sanitizedPaths.length > 0 ? sanitizedPaths : undefined,
        projectIconSvg,
        defaultWorktreeRecipeId,
        devServerCommand: devServerCommand.trim() || undefined,
        devServerLoadTimeout,
        commandOverrides: commandOverrides.length > 0 ? commandOverrides : undefined,
        copyTreeSettings: hasCopyTreeSettings ? sanitizedCopyTreeSettings : undefined,
        branchPrefixMode: effectivePrefixMode !== "none" ? effectivePrefixMode : undefined,
        branchPrefixCustom: effectivePrefixMode === "custom" ? sanitizedBranchPrefixCustom : undefined,
        worktreePathPattern: sanitizedWorktreePathPattern,
        terminalSettings: currentTerminalSettings,
        notificationOverrides: Object.keys(notificationOverrides).length > 0 ? notificationOverrides : undefined,
        insecureEnvironmentVariables: undefined,
        unresolvedSecureEnvironmentVariables: undefined,
      });

      if (currentProjectSnapshot) {
        lastSavedSnapshotRef.current = currentProjectSnapshot;
      }
    } catch (err) {
      console.error("Failed to auto-save project settings:", err);
      setProjectAutoSaveError(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  const debouncedProjectSaveRef = useRef(
    debounce(() => { projectPersistRef.current?.(); }, 500)
  );

  useEffect(() => {
    if (!projectIsInitialized || !currentProjectSnapshot || !lastSavedSnapshotRef.current) return;
    if (areSnapshotsEqual(lastSavedSnapshotRef.current, currentProjectSnapshot)) return;
    debouncedProjectSaveRef.current();
  }, [currentProjectSnapshot, projectIsInitialized]);

  useEffect(() => {
    const save = debouncedProjectSaveRef.current;
    return () => { save.cancel(); };
  }, []);

  const handleBeforeClose = useCallback(async () => {
    await debouncedProjectSaveRef.current.flush();
    return true;
  }, []);

  const handleClose = useCallback(async () => {
    await debouncedProjectSaveRef.current.flush();
    onClose();
  }, [onClose]);
  // ── End project settings state machine ──

  const searchResults = useMemo(
    () => filterSettings(SETTINGS_SEARCH_INDEX, deferredQuery, { modifiedTabs, scope: activeScope }),
    [deferredQuery, modifiedTabs, activeScope]
  );

  const cleanSearchQuery = useMemo(() => parseQuery(deferredQuery).cleanQuery, [deferredQuery]);

  const matchCounts = useMemo(() => countMatchesPerTab(searchResults), [searchResults]);

  // Use live searchQuery for mode switching to avoid deferred split-brain;
  // deferredQuery drives the expensive filtering computation only.
  const isSearching = searchQuery.trim().length > 0;

  const handleResultClick = ({ tab, subtab, sectionId }: SettingsNavTarget) => {
    markTabVisited(tab);
    setSearchQuery("");
    setScrollToSection(sectionId ?? null);
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
        handleResultClick({ tab: result.tab, subtab: result.subtab, sectionId: result.id });
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
    "project:automation": "Automation",
    "project:recipes": "Recipes",
    "project:commands": "Commands",
    "project:notifications": "Notifications",
  };

  const tabIcons: Record<SettingsTab, React.ReactNode> = {
    general: <Settings2 className="w-5 h-5 text-text-secondary" />,
    keyboard: <Keyboard className="w-5 h-5 text-text-secondary" />,
    terminal: <LayoutGrid className="w-5 h-5 text-text-secondary" />,
    terminalAppearance: <SquareTerminal className="w-5 h-5 text-text-secondary" />,
    worktree: <WorktreeIcon className="w-5 h-5 text-text-secondary" />,
    agents: <CanopyAgentIcon className="w-5 h-5 text-text-secondary" />,
    github: <Github className="w-5 h-5 text-text-secondary" />,
    portal: <PanelRight className="w-5 h-5 text-text-secondary" />,
    toolbar: <SettingsIcon className="w-5 h-5 text-text-secondary" />,
    notifications: <Bell className="w-5 h-5 text-text-secondary" />,
    integrations: <Blocks className="w-5 h-5 text-text-secondary" />,
    voice: <Mic className="w-5 h-5 text-text-secondary" />,
    mcp: <Plug className="w-5 h-5 text-text-secondary" />,
    environment: <KeyRound className="w-5 h-5 text-text-secondary" />,
    privacy: <Shield className="w-5 h-5 text-text-secondary" />,
    troubleshooting: <LifeBuoy className="w-5 h-5 text-text-secondary" />,
    "project:general": <SettingsIcon className="w-5 h-5 text-text-secondary" />,
    "project:context": <FileCode className="w-5 h-5 text-text-secondary" />,
    "project:automation": <Zap className="w-5 h-5 text-text-secondary" />,
    "project:recipes": <CookingPot className="w-5 h-5 text-text-secondary" />,
    "project:commands": <Command className="w-5 h-5 text-text-secondary" />,
    "project:notifications": <Bell className="w-5 h-5 text-text-secondary" />,
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
        <div className="settings-sidebar w-48 border-r border-canopy-border p-3 flex flex-col shrink-0">
          <h2 className="text-sm font-semibold text-canopy-text mb-2 px-2">Settings</h2>

          {hasProject && (
            <div className="flex gap-1 mb-2 px-1">
              <button
                type="button"
                onClick={() => handleScopeSwitch("global")}
                className={cn(
                  "flex-1 text-xs py-1 px-2 rounded-[var(--radius-md)] font-medium transition-colors",
                  activeScope === "global"
                    ? "bg-canopy-accent/15 text-canopy-accent"
                    : "text-text-secondary hover:text-canopy-text hover:bg-overlay-subtle"
                )}
              >
                Global
              </button>
              <button
                type="button"
                onClick={() => handleScopeSwitch("project")}
                className={cn(
                  "flex-1 text-xs py-1 px-2 rounded-[var(--radius-md)] font-medium transition-colors",
                  activeScope === "project"
                    ? "bg-canopy-accent/15 text-canopy-accent"
                    : "text-text-secondary hover:text-canopy-text hover:bg-overlay-subtle"
                )}
              >
                Project
              </button>
            </div>
          )}

          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-1.5 mb-2 rounded-[var(--radius-md)]",
              "settings-search border border-canopy-border",
              "focus-within:border-canopy-accent focus-within:ring-1 focus-within:ring-canopy-accent/20"
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
              className="settings-search-input flex-1 min-w-0 text-xs bg-transparent text-canopy-text focus:outline-none"
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
                className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-[var(--settings-sidebar-bg,var(--theme-surface-sidebar))] to-transparent z-10"
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
              {activeScope === "global" ? (
                <>
                  <NavGroup label="General">
                    <NavItem tab="general" icon={<Settings2 className="w-4 h-4" />} label="General" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.general} modified={modifiedTabs.has("general")} onSelect={handleNavSelect} />
                    <NavItem tab="terminalAppearance" icon={<SquareTerminal className="w-4 h-4" />} label="Appearance" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.terminalAppearance} onSelect={handleNavSelect} />
                    <NavItem tab="keyboard" icon={<Keyboard className="w-4 h-4" />} label="Keyboard" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.keyboard} onSelect={handleNavSelect} />
                    <NavItem tab="notifications" icon={<Bell className="w-4 h-4" />} label="Notifications" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.notifications} onSelect={handleNavSelect} />
                    <NavItem tab="privacy" icon={<Shield className="w-4 h-4" />} label="Privacy & Data" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.privacy} onSelect={handleNavSelect} />
                  </NavGroup>
                  <NavGroup label="Terminal">
                    <NavItem tab="terminal" icon={<LayoutGrid className="w-4 h-4" />} label="Panel Grid" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.terminal} modified={modifiedTabs.has("terminal")} onSelect={handleNavSelect} />
                    <NavItem tab="worktree" icon={<WorktreeIcon className="w-4 h-4" />} label="Worktree" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.worktree} onSelect={handleNavSelect} />
                    <NavItem tab="toolbar" icon={<SettingsIcon className="w-4 h-4" />} label="Toolbar" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.toolbar} onSelect={handleNavSelect} />
                    <NavItem tab="environment" icon={<KeyRound className="w-4 h-4" />} label="Environment" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.environment} onSelect={handleNavSelect} />
                  </NavGroup>
                  <NavGroup label="Integrations">
                    <NavItem tab="agents" icon={<CanopyAgentIcon className="w-4 h-4" />} label="CLI Agents" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.agents} onSelect={handleNavSelect} />
                    <NavItem tab="github" icon={<Github className="w-4 h-4" />} label="GitHub" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.github} onSelect={handleNavSelect} />
                    <NavItem tab="integrations" icon={<Blocks className="w-4 h-4" />} label="Integrations" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.integrations} onSelect={handleNavSelect} />
                    <NavItem tab="portal" icon={<PanelRight className="w-4 h-4" />} label="Portal" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.portal} onSelect={handleNavSelect} />
                    <NavItem tab="mcp" icon={<Plug className="w-4 h-4" />} label="MCP Server" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.mcp} onSelect={handleNavSelect} />
                  </NavGroup>
                  <NavGroup label="Input">
                    <NavItem tab="voice" icon={<Mic className="w-4 h-4" />} label="Voice Input" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.voice} onSelect={handleNavSelect} />
                  </NavGroup>
                  <NavGroup label="Support">
                    <NavItem tab="troubleshooting" icon={<LifeBuoy className="w-4 h-4" />} label="Troubleshooting" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts.troubleshooting} onSelect={handleNavSelect} />
                  </NavGroup>
                </>
              ) : (
                <NavGroup label="Project">
                  <NavItem tab="project:general" icon={<SettingsIcon className="w-4 h-4" />} label="General" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts["project:general"]} onSelect={handleNavSelect} />
                  <NavItem tab="project:context" icon={<FileCode className="w-4 h-4" />} label="Context" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts["project:context"]} onSelect={handleNavSelect} />
                  <NavItem tab="project:automation" icon={<Zap className="w-4 h-4" />} label="Automation" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts["project:automation"]} onSelect={handleNavSelect} />
                  <NavItem tab="project:recipes" icon={<CookingPot className="w-4 h-4" />} label="Recipes" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts["project:recipes"]} onSelect={handleNavSelect} />
                  <NavItem tab="project:commands" icon={<Command className="w-4 h-4" />} label="Commands" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts["project:commands"]} onSelect={handleNavSelect} />
                  <NavItem tab="project:notifications" icon={<Bell className="w-4 h-4" />} label="Notifications" activeTab={activeTab} isSearching={isSearching} matchCount={matchCounts["project:notifications"]} onSelect={handleNavSelect} />
                </NavGroup>
              )}
            </div>
            {canScrollDown && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--settings-sidebar-bg,var(--theme-surface-sidebar))] to-transparent z-10"
              />
            )}
          </div>

          <div className="pt-2 mt-2 border-t border-canopy-border px-2">
            <span className="settings-meta font-mono">{appVersion}</span>
          </div>
        </div>

        <div className="settings-shell flex-1 flex flex-col min-w-0">
          <div className="settings-header flex items-center justify-between px-6 py-4 border-b border-canopy-border shrink-0">
            <h3 className="text-lg font-medium text-canopy-text flex items-center gap-2">
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
                    {projectIsLoading && (
                      <div className="text-sm text-canopy-text/60 text-center py-8">
                        Loading settings...
                      </div>
                    )}
                    {projectError && (
                      <div className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4" role="alert">
                        Failed to load settings: {projectError}
                      </div>
                    )}
                    {projectAutoSaveError && (
                      <div className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4" role="alert">
                        {projectAutoSaveError}
                      </div>
                    )}
                    {!projectIsLoading && !projectError && (
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
                              currentProject={currentProject}
                              name={projectName}
                              onNameChange={setProjectName}
                              emoji={projectEmoji}
                              onEmojiChange={setProjectEmoji}
                              color={projectColor}
                              onColorChange={setProjectColor}
                              devServerCommand={devServerCommand}
                              onDevServerCommandChange={setDevServerCommand}
                              devServerLoadTimeout={devServerLoadTimeout}
                              onDevServerLoadTimeoutChange={setDevServerLoadTimeout}
                              projectIconSvg={projectIconSvg}
                              onProjectIconSvgChange={setProjectIconSvg}
                              enableInRepoSettings={enableInRepoSettings}
                              disableInRepoSettings={disableInRepoSettings}
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
                              excludedPaths={excludedPaths}
                              onExcludedPathsChange={setExcludedPaths}
                              copyTreeSettings={copyTreeSettings}
                              onCopyTreeSettingsChange={setCopyTreeSettings}
                              environmentVariables={environmentVariables}
                              onEnvironmentVariablesChange={setEnvironmentVariables}
                              worktrees={worktrees}
                              settings={projectSettings}
                              isOpen={isOpen}
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
                              currentProject={currentProject}
                              runCommands={runCommands}
                              onRunCommandsChange={setRunCommands}
                              defaultWorktreeRecipeId={defaultWorktreeRecipeId}
                              onDefaultWorktreeRecipeIdChange={setDefaultWorktreeRecipeId}
                              branchPrefixMode={branchPrefixMode}
                              onBranchPrefixModeChange={setBranchPrefixMode}
                              branchPrefixCustom={branchPrefixCustom}
                              onBranchPrefixCustomChange={setBranchPrefixCustom}
                              worktreePathPattern={worktreePathPattern}
                              onWorktreePathPatternChange={setWorktreePathPattern}
                              terminalShell={terminalShell}
                              onTerminalShellChange={setTerminalShell}
                              terminalShellArgs={terminalShellArgs}
                              onTerminalShellArgsChange={setTerminalShellArgs}
                              terminalDefaultCwd={terminalDefaultCwd}
                              onTerminalDefaultCwdChange={setTerminalDefaultCwd}
                              terminalScrollback={terminalScrollback}
                              onTerminalScrollbackChange={setTerminalScrollback}
                              recipes={recipes}
                              recipesLoading={recipesLoading}
                              onNavigateToRecipes={() => {
                                markTabVisited("project:recipes");
                                startTransition(() => setActiveTab("project:recipes"));
                              }}
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
                              defaultWorktreeRecipeId={defaultWorktreeRecipeId}
                              onDefaultWorktreeRecipeIdChange={setDefaultWorktreeRecipeId}
                              worktreeMap={worktreeMap}
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
                              overrides={commandOverrides}
                              onChange={setCommandOverrides}
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
                              overrides={notificationOverrides}
                              onChange={setNotificationOverrides}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}
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
        "settings-nav-item",
        active
          ? "text-canopy-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "text-text-secondary hover:text-canopy-text"
      )}
      data-active={active ? "true" : undefined}
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
          <span className="tabular-nums">{results.length}</span> result
          {results.length === 1 ? "" : "s"}
        </p>
        <p className="text-[10px] text-canopy-text/30">
          <kbd className="settings-kbd px-1 py-0.5 rounded border font-mono">↑↓</kbd> navigate{" "}
          <kbd className="settings-kbd px-1 py-0.5 rounded border font-mono">↵</kbd> go
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
