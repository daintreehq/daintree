import { useState, useEffect, useRef, useMemo } from "react";
import {
  Sprout,
  X,
  Settings,
  FileCode,
  Zap,
  Command,
  CookingPot,
  Server,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { useProjectSettings } from "@/hooks";
import { useProjectStore } from "@/store/projectStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { RunCommand, CopyTreeSettings } from "@/types";
import type { ProjectTerminalSettings, ProjectMcpServerConfig } from "@shared/types/project";
import type { ProjectMcpServerRunState } from "@shared/types/ipc/project";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import { cn } from "@/lib/utils";
import { CommandOverridesTab } from "@/components/Settings/CommandOverridesTab";
import { McpServersTab } from "./McpServersTab";
import { ProjectNotificationsTab } from "./ProjectNotificationsTab";
import { GeneralTab } from "./GeneralTab";
import { ContextTab } from "./ContextTab";
import { AutomationTab } from "./AutomationTab";
import { RecipesTab } from "./RecipesTab";
import { AgentTab } from "./AgentTab";
import type { CommandOverride } from "@shared/types/commands";
import type { NotificationSettings } from "@shared/types/ipc/api";
import {
  createProjectSettingsSnapshot,
  areSnapshotsEqual,
  type ProjectSettingsSnapshot,
  type EnvVar,
} from "./projectSettingsDirty";
import { validatePathPattern } from "@shared/utils/pathPattern";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useRecipeStore } from "@/store/recipeStore";

interface ProjectSettingsDialogProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}

type ProjectSettingsTab =
  | "general"
  | "context"
  | "automation"
  | "recipes"
  | "commands"
  | "agent"
  | "mcp"
  | "notifications";

export { GITIGNORE_SNIPPET } from "./projectSettingsConstants";

export function ProjectSettingsDialog({ projectId, isOpen, onClose }: ProjectSettingsDialogProps) {
  const { settings, saveSettings, isLoading, error } = useProjectSettings(projectId);
  const { projects, updateProject, enableInRepoSettings, disableInRepoSettings } =
    useProjectStore();
  const currentProject = projects.find((p) => p.id === projectId);

  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>("general");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [name, setName] = useState(currentProject?.name || "");
  const [emoji, setEmoji] = useState(currentProject?.emoji || "🌲");

  const [runCommands, setRunCommands] = useState<RunCommand[]>([]);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvVar[]>([]);
  const [excludedPaths, setExcludedPaths] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [projectIconSvg, setProjectIconSvg] = useState<string | undefined>(undefined);
  const [defaultWorktreeRecipeId, setDefaultWorktreeRecipeId] = useState<string | undefined>(
    undefined
  );
  const [devServerCommand, setDevServerCommand] = useState<string>("");
  const [devServerLoadTimeout, setDevServerLoadTimeout] = useState<number | undefined>(undefined);
  const [commandOverrides, setCommandOverrides] = useState<CommandOverride[]>([]);
  const [copyTreeSettings, setCopyTreeSettings] = useState<CopyTreeSettings>({});
  const [branchPrefixMode, setBranchPrefixMode] = useState<"none" | "username" | "custom">("none");
  const [branchPrefixCustom, setBranchPrefixCustom] = useState<string>("");
  const [agentInstructions, setAgentInstructions] = useState<string>("");
  const [worktreePathPattern, setWorktreePathPattern] = useState<string>("");
  const [terminalShell, setTerminalShell] = useState<string>("");
  const [terminalShellArgs, setTerminalShellArgs] = useState<string>("");
  const [terminalDefaultCwd, setTerminalDefaultCwd] = useState<string>("");
  const [terminalScrollback, setTerminalScrollback] = useState<string>("");
  const [mcpServers, setMcpServers] = useState<Record<string, ProjectMcpServerConfig>>({});
  const [mcpRunStates, setMcpRunStates] = useState<ProjectMcpServerRunState[]>([]);
  const [notificationOverrides, setNotificationOverrides] = useState<Partial<NotificationSettings>>(
    {}
  );
  const initialSnapshotRef = useRef<ProjectSettingsSnapshot | null>(null);
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] = useState(false);

  const { recipes, isLoading: recipesLoading } = useRecipeStore();
  const { worktreeMap, worktrees } = useWorktrees();

  const currentTerminalSettings = useMemo((): ProjectTerminalSettings | undefined => {
    const result: ProjectTerminalSettings = {};
    if (terminalShell.trim()) result.shell = terminalShell.trim();
    if (terminalShellArgs.trim()) {
      result.shellArgs = terminalShellArgs.trim().split(/\s+/);
    }
    if (terminalDefaultCwd.trim()) result.defaultWorkingDirectory = terminalDefaultCwd.trim();
    if (terminalScrollback.trim()) {
      const num = Number(terminalScrollback);
      if (Number.isFinite(num) && num >= SCROLLBACK_MIN && num <= SCROLLBACK_MAX) {
        result.scrollbackLines = Math.trunc(num);
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }, [terminalShell, terminalShellArgs, terminalDefaultCwd, terminalScrollback]);

  const currentSnapshot = useMemo(() => {
    if (!currentProject) return null;
    return createProjectSettingsSnapshot(
      name,
      emoji,
      devServerCommand,
      projectIconSvg,
      excludedPaths,
      environmentVariables,
      runCommands,
      defaultWorktreeRecipeId,
      commandOverrides,
      copyTreeSettings,
      branchPrefixMode,
      branchPrefixCustom,
      devServerLoadTimeout,
      agentInstructions,
      worktreePathPattern,
      currentTerminalSettings,
      mcpServers,
      notificationOverrides
    );
  }, [
    name,
    emoji,
    devServerCommand,
    devServerLoadTimeout,
    projectIconSvg,
    excludedPaths,
    environmentVariables,
    runCommands,
    defaultWorktreeRecipeId,
    commandOverrides,
    copyTreeSettings,
    branchPrefixMode,
    branchPrefixCustom,
    agentInstructions,
    worktreePathPattern,
    currentProject,
    currentTerminalSettings,
    mcpServers,
    notificationOverrides,
  ]);

  const isDirty = useMemo(() => {
    if (!initialSnapshotRef.current || !currentSnapshot) return false;
    return !areSnapshotsEqual(initialSnapshotRef.current, currentSnapshot);
  }, [currentSnapshot]);

  useEffect(() => {
    if (isOpen && !isLoading && settings && currentProject && !isInitialized) {
      const initialRunCommands = settings.runCommands || [];
      const envVars = settings.environmentVariables || {};
      const initialEnvVars = Object.entries(envVars).map(([key, value]) => ({
        id: `env-${Date.now()}-${Math.random()}`,
        key,
        value,
      }));
      const initialExcludedPaths = settings.excludedPaths || [];
      const initialProjectIconSvg = settings.projectIconSvg;
      const initialDefaultWorktreeRecipeId = settings.defaultWorktreeRecipeId;
      const initialDevServerCommand = settings.devServerCommand || "";
      const initialDevServerLoadTimeout = settings.devServerLoadTimeout;
      const initialCommandOverrides = settings.commandOverrides || [];
      const initialCopyTreeSettings = settings.copyTreeSettings || {};
      const initialBranchPrefixMode = settings.branchPrefixMode ?? "none";
      const initialBranchPrefixCustom = settings.branchPrefixCustom ?? "";
      const initialAgentInstructions = settings.agentInstructions ?? "";
      const initialWorktreePathPattern = settings.worktreePathPattern ?? "";
      const initialTerminalSettings = settings.terminalSettings;
      const initialMcpServers = settings.mcpServers ?? {};
      const initialNotificationOverrides = settings.notificationOverrides ?? {};

      setName(currentProject.name);
      setEmoji(currentProject.emoji || "🌲");
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
      setAgentInstructions(initialAgentInstructions);
      setWorktreePathPattern(initialWorktreePathPattern);
      setTerminalShell(initialTerminalSettings?.shell ?? "");
      setTerminalShellArgs(initialTerminalSettings?.shellArgs?.join(" ") ?? "");
      setTerminalDefaultCwd(initialTerminalSettings?.defaultWorkingDirectory ?? "");
      setTerminalScrollback(
        initialTerminalSettings?.scrollbackLines !== undefined
          ? String(initialTerminalSettings.scrollbackLines)
          : ""
      );
      setMcpServers(initialMcpServers);
      setNotificationOverrides(initialNotificationOverrides);

      initialSnapshotRef.current = createProjectSettingsSnapshot(
        currentProject.name,
        currentProject.emoji || "🌲",
        initialDevServerCommand,
        initialProjectIconSvg,
        initialExcludedPaths,
        initialEnvVars,
        initialRunCommands,
        initialDefaultWorktreeRecipeId,
        initialCommandOverrides,
        initialCopyTreeSettings,
        initialBranchPrefixMode,
        initialBranchPrefixCustom,
        initialDevServerLoadTimeout,
        initialAgentInstructions,
        initialWorktreePathPattern,
        initialTerminalSettings,
        initialMcpServers,
        initialNotificationOverrides
      );

      setIsInitialized(true);
    }
    if (!isOpen) {
      setIsInitialized(false);
      setEnvironmentVariables([]);
      setProjectIconSvg(undefined);
      setDefaultWorktreeRecipeId(undefined);
      setDevServerCommand("");
      setDevServerLoadTimeout(undefined);
      setCommandOverrides([]);
      setCopyTreeSettings({});
      setSaveError(null);
      setBranchPrefixMode("none");
      setBranchPrefixCustom("");
      setAgentInstructions("");
      setWorktreePathPattern("");
      setTerminalShell("");
      setTerminalShellArgs("");
      setTerminalDefaultCwd("");
      setTerminalScrollback("");
      setMcpServers({});
      setMcpRunStates([]);
      setNotificationOverrides({});
      setActiveTab("general");
      initialSnapshotRef.current = null;
      setShowUnsavedChangesDialog(false);
    }
  }, [settings, isOpen, isInitialized, currentProject, isLoading]);

  useEffect(() => {
    if (isOpen) {
      setIsInitialized(false);
    }
  }, [projectId, isOpen]);

  useEffect(() => {
    if (!isOpen || !projectId) return;

    window.electron.projectMcp
      .getStatuses(projectId)
      .then(setMcpRunStates)
      .catch(() => {});

    const cleanup = window.electron.projectMcp.onStatusChanged((payload) => {
      if (payload.projectId === projectId) {
        setMcpRunStates(payload.servers as ProjectMcpServerRunState[]);
      }
    });
    return cleanup;
  }, [isOpen, projectId]);

  const requestClose = (options?: { bypassDirty?: boolean }) => {
    if (options?.bypassDirty || !isDirty) {
      onClose();
      return;
    }
    setShowUnsavedChangesDialog(true);
  };

  const handleSave = async () => {
    if (!settings || isSaving) return;

    const sanitizedRunCommands = runCommands
      .map((cmd) => ({
        ...cmd,
        name: cmd.name.trim(),
        command: cmd.command.trim(),
      }))
      .filter((cmd) => cmd.name && cmd.command);

    const envVarRecord: Record<string, string> = {};
    const seenKeys = new Set<string>();
    for (const envVar of environmentVariables) {
      const trimmedKey = envVar.key.trim();
      if (!trimmedKey) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
        setSaveError(
          `Invalid environment variable key: "${trimmedKey}". Use only letters, numbers, and underscores.`
        );
        setActiveTab("context");
        return;
      }
      if (seenKeys.has(trimmedKey)) {
        setSaveError(`Duplicate environment variable key: "${trimmedKey}"`);
        setActiveTab("context");
        return;
      }
      seenKeys.add(trimmedKey);
      envVarRecord[trimmedKey] = envVar.value;
    }

    const sanitizedPaths = excludedPaths.map((p) => p.trim()).filter(Boolean);

    setIsSaving(true);
    setSaveError(null);
    try {
      if (currentProject) {
        await updateProject(projectId, {
          name: name.trim() || currentProject.name,
          emoji: emoji,
        });
      }

      const sanitizedCopyTreeSettings: CopyTreeSettings = {};
      if (copyTreeSettings.maxContextSize !== undefined) {
        sanitizedCopyTreeSettings.maxContextSize = copyTreeSettings.maxContextSize;
      }
      if (copyTreeSettings.maxFileSize !== undefined) {
        sanitizedCopyTreeSettings.maxFileSize = copyTreeSettings.maxFileSize;
      }
      if (copyTreeSettings.charLimit !== undefined) {
        sanitizedCopyTreeSettings.charLimit = copyTreeSettings.charLimit;
      }
      if (copyTreeSettings.strategy) {
        sanitizedCopyTreeSettings.strategy = copyTreeSettings.strategy;
      }
      if (copyTreeSettings.alwaysInclude && copyTreeSettings.alwaysInclude.length > 0) {
        sanitizedCopyTreeSettings.alwaysInclude = copyTreeSettings.alwaysInclude
          .map((p) => p.trim())
          .filter(Boolean);
        if (sanitizedCopyTreeSettings.alwaysInclude.length === 0) {
          delete sanitizedCopyTreeSettings.alwaysInclude;
        }
      }
      if (copyTreeSettings.alwaysExclude && copyTreeSettings.alwaysExclude.length > 0) {
        sanitizedCopyTreeSettings.alwaysExclude = copyTreeSettings.alwaysExclude
          .map((p) => p.trim())
          .filter(Boolean);
        if (sanitizedCopyTreeSettings.alwaysExclude.length === 0) {
          delete sanitizedCopyTreeSettings.alwaysExclude;
        }
      }
      const hasCopyTreeSettings = Object.keys(sanitizedCopyTreeSettings).length > 0;

      const sanitizedBranchPrefixCustom = branchPrefixCustom.trim();
      const effectivePrefixMode =
        branchPrefixMode === "custom" && !sanitizedBranchPrefixCustom ? "none" : branchPrefixMode;
      const sanitizedWorktreePathPattern = worktreePathPattern.trim() || undefined;
      if (sanitizedWorktreePathPattern) {
        const patternValidation = validatePathPattern(sanitizedWorktreePathPattern);
        if (!patternValidation.valid) {
          setSaveError(`Invalid worktree path pattern: ${patternValidation.error}`);
          setIsSaving(false);
          return;
        }
      }

      await saveSettings({
        ...settings,
        runCommands: sanitizedRunCommands,
        environmentVariables: Object.keys(envVarRecord).length > 0 ? envVarRecord : undefined,
        excludedPaths: sanitizedPaths.length > 0 ? sanitizedPaths : undefined,
        projectIconSvg: projectIconSvg,
        defaultWorktreeRecipeId: defaultWorktreeRecipeId,
        devServerCommand: devServerCommand.trim() || undefined,
        devServerLoadTimeout: devServerLoadTimeout,
        commandOverrides: commandOverrides.length > 0 ? commandOverrides : undefined,
        copyTreeSettings: hasCopyTreeSettings ? sanitizedCopyTreeSettings : undefined,
        branchPrefixMode: effectivePrefixMode !== "none" ? effectivePrefixMode : undefined,
        branchPrefixCustom:
          effectivePrefixMode === "custom" ? sanitizedBranchPrefixCustom : undefined,
        agentInstructions: agentInstructions.trim() || undefined,
        worktreePathPattern: sanitizedWorktreePathPattern,
        terminalSettings: currentTerminalSettings,
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        notificationOverrides:
          Object.keys(notificationOverrides).length > 0 ? notificationOverrides : undefined,
        insecureEnvironmentVariables: undefined,
        unresolvedSecureEnvironmentVariables: undefined,
      });

      const sanitizedEnvVars = Object.entries(envVarRecord).map(([key, value]) => ({
        id: environmentVariables.find((ev) => ev.key.trim() === key)?.id || key,
        key,
        value,
      }));

      const sanitizedRunCommandsWithIds = sanitizedRunCommands.map((cmd) => ({
        id: cmd.id || "",
        name: cmd.name,
        command: cmd.command,
        preferredLocation: cmd.preferredLocation,
        preferredAutoRestart: cmd.preferredAutoRestart,
      }));

      initialSnapshotRef.current = createProjectSettingsSnapshot(
        name.trim() || (currentProject?.name ?? ""),
        emoji,
        devServerCommand.trim() || "",
        projectIconSvg,
        sanitizedPaths,
        sanitizedEnvVars,
        sanitizedRunCommandsWithIds,
        defaultWorktreeRecipeId,
        commandOverrides.length > 0 ? commandOverrides : [],
        hasCopyTreeSettings ? sanitizedCopyTreeSettings : {},
        branchPrefixMode,
        sanitizedBranchPrefixCustom,
        devServerLoadTimeout,
        agentInstructions,
        worktreePathPattern.trim(),
        currentTerminalSettings,
        mcpServers,
        notificationOverrides
      );

      requestClose({ bypassDirty: true });
    } catch (error) {
      console.error("Failed to save settings:", error);
      setSaveError(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const tabTitles: Record<ProjectSettingsTab, string> = {
    general: "General",
    context: "Context",
    automation: "Automation",
    recipes: "Recipes",
    commands: "Commands",
    agent: "Agent",
    mcp: "MCP Servers",
    notifications: "Notifications",
  };

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={requestClose}
        dismissible={!showUnsavedChangesDialog}
        size="4xl"
        maxHeight="h-[75vh]"
        className="max-h-[800px]"
      >
        <div className="flex h-full overflow-hidden">
          <div className="w-48 border-r border-canopy-border bg-canopy-bg/50 p-4 flex flex-col gap-2 shrink-0">
            <h2 className="text-sm font-semibold text-canopy-text mb-4 px-2">Project Settings</h2>
            <NavButton
              active={activeTab === "general"}
              onClick={() => setActiveTab("general")}
              icon={<Settings className="w-4 h-4" />}
            >
              General
            </NavButton>
            <NavButton
              active={activeTab === "context"}
              onClick={() => setActiveTab("context")}
              icon={<FileCode className="w-4 h-4" />}
            >
              Context
            </NavButton>
            <NavButton
              active={activeTab === "automation"}
              onClick={() => setActiveTab("automation")}
              icon={<Zap className="w-4 h-4" />}
            >
              Automation
            </NavButton>
            <NavButton
              active={activeTab === "recipes"}
              onClick={() => setActiveTab("recipes")}
              icon={<CookingPot className="w-4 h-4" />}
            >
              Recipes
            </NavButton>
            <NavButton
              active={activeTab === "commands"}
              onClick={() => setActiveTab("commands")}
              icon={<Command className="w-4 h-4" />}
            >
              Commands
            </NavButton>
            <NavButton
              active={activeTab === "agent"}
              onClick={() => setActiveTab("agent")}
              icon={<Sprout className="w-4 h-4" />}
            >
              Agent
            </NavButton>
            <NavButton
              active={activeTab === "mcp"}
              onClick={() => setActiveTab("mcp")}
              icon={<Server className="w-4 h-4" />}
            >
              MCP Servers
            </NavButton>
            <NavButton
              active={activeTab === "notifications"}
              onClick={() => setActiveTab("notifications")}
              icon={<Bell className="w-4 h-4" />}
            >
              Notifications
            </NavButton>
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center justify-between px-6 py-4 border-b border-canopy-border bg-canopy-sidebar/50 shrink-0">
              <h3 className="text-lg font-medium text-canopy-text">{tabTitles[activeTab]}</h3>
              <button
                onClick={() => requestClose()}
                className="text-canopy-text/60 hover:text-canopy-text transition-colors p-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
                aria-label="Close settings"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              {isLoading && (
                <div className="text-sm text-canopy-text/60 text-center py-8">
                  Loading settings...
                </div>
              )}
              {error && (
                <div
                  className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4"
                  role="alert"
                >
                  Failed to load settings: {error}
                </div>
              )}
              {saveError && (
                <div
                  className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3 mb-4"
                  role="alert"
                >
                  {saveError}
                </div>
              )}
              {!isLoading && !error && (
                <>
                  {/* General Tab */}
                  <div className={activeTab === "general" ? "" : "hidden"}>
                    <GeneralTab
                      currentProject={currentProject}
                      name={name}
                      onNameChange={setName}
                      emoji={emoji}
                      onEmojiChange={setEmoji}
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
                  </div>

                  {/* Context Tab */}
                  <div className={activeTab === "context" ? "" : "hidden"}>
                    <ContextTab
                      excludedPaths={excludedPaths}
                      onExcludedPathsChange={setExcludedPaths}
                      copyTreeSettings={copyTreeSettings}
                      onCopyTreeSettingsChange={setCopyTreeSettings}
                      environmentVariables={environmentVariables}
                      onEnvironmentVariablesChange={setEnvironmentVariables}
                      worktrees={worktrees}
                      settings={settings}
                      isOpen={isOpen}
                    />
                  </div>

                  {/* Automation Tab */}
                  <div className={activeTab === "automation" ? "" : "hidden"}>
                    <AutomationTab
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
                      onNavigateToRecipes={() => setActiveTab("recipes")}
                    />
                  </div>

                  {/* Recipes Tab */}
                  <div className={activeTab === "recipes" ? "" : "hidden"}>
                    <RecipesTab
                      projectId={projectId}
                      defaultWorktreeRecipeId={defaultWorktreeRecipeId}
                      onDefaultWorktreeRecipeIdChange={setDefaultWorktreeRecipeId}
                      worktreeMap={worktreeMap}
                      isOpen={isOpen}
                    />
                  </div>

                  {/* Commands Tab */}
                  <div className={activeTab === "commands" ? "" : "hidden"}>
                    <CommandOverridesTab
                      projectId={projectId}
                      overrides={commandOverrides}
                      onChange={setCommandOverrides}
                    />
                  </div>

                  {/* Agent Tab */}
                  <div className={activeTab === "agent" ? "" : "hidden"}>
                    <AgentTab
                      agentInstructions={agentInstructions}
                      onAgentInstructionsChange={setAgentInstructions}
                    />
                  </div>

                  {/* MCP Servers Tab */}
                  <div className={activeTab === "mcp" ? "" : "hidden"}>
                    <McpServersTab
                      servers={mcpServers}
                      onChange={setMcpServers}
                      runStates={mcpRunStates}
                    />
                  </div>

                  {/* Notifications Tab */}
                  <div className={activeTab === "notifications" ? "" : "hidden"}>
                    <ProjectNotificationsTab
                      overrides={notificationOverrides}
                      onChange={setNotificationOverrides}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-canopy-border bg-canopy-sidebar/50 shrink-0">
              <Button variant="ghost" onClick={() => requestClose()}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving || isLoading || !!error}>
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      </AppDialog>

      <ConfirmDialog
        isOpen={showUnsavedChangesDialog}
        title="Unsaved Changes"
        description="You have unsaved changes. Are you sure you want to discard them?"
        confirmLabel="Discard Changes"
        cancelLabel="Keep Editing"
        variant="destructive"
        onConfirm={() => {
          setShowUnsavedChangesDialog(false);
          onClose();
        }}
        onClose={() => {
          setShowUnsavedChangesDialog(false);
        }}
      />
    </>
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
        "relative text-left px-3 py-2 rounded-[var(--radius-md)] text-sm transition-colors flex items-center gap-2",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
        active
          ? "bg-surface-panel-elevated shadow-sm text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "text-canopy-text/60 hover:bg-overlay-subtle hover:text-canopy-text"
      )}
    >
      {icon}
      {children}
    </button>
  );
}
