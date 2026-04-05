import { useState, useEffect, useMemo, useRef } from "react";
import { useProjectSettings } from "@/hooks/useProjectSettings";
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
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";

interface UseProjectSettingsFormParams {
  projectId: string | null;
  isOpen: boolean;
}

export function useProjectSettingsForm({ projectId, isOpen }: UseProjectSettingsFormParams) {
  const {
    settings: projectSettings,
    saveSettings: saveProjectSettings,
    isLoading: projectIsLoading,
    error: projectError,
  } = useProjectSettings(projectId ?? "");
  const projects = useProjectStore((state) => state.projects);
  const updateProject = useProjectStore((state) => state.updateProject);
  const enableInRepoSettings = useProjectStore((state) => state.enableInRepoSettings);
  const disableInRepoSettings = useProjectStore((state) => state.disableInRepoSettings);
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
  const [defaultWorktreeRecipeId, setDefaultWorktreeRecipeId] = useState<string | undefined>(
    undefined
  );
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
  const [notificationOverrides, setNotificationOverrides] = useState<Partial<NotificationSettings>>(
    {}
  );
  const [githubRemote, setGithubRemote] = useState<string | undefined>(undefined);
  const lastSavedSnapshotRef = useRef<ReturnType<typeof createProjectSettingsSnapshot> | null>(
    null
  );
  const currentProjectSnapshotRef = useRef<ReturnType<typeof createProjectSettingsSnapshot> | null>(
    null
  );
  const prevProjectIdRef = useRef<string | null>(null);

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
      projectName,
      projectEmoji,
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
      githubRemote,
      worktreePathPattern,
      currentTerminalSettings,
      notificationOverrides,
      projectColor
    );
  }, [
    projectName,
    projectEmoji,
    projectColor,
    devServerCommand,
    devServerLoadTimeout,
    githubRemote,
    projectIconSvg,
    excludedPaths,
    environmentVariables,
    runCommands,
    defaultWorktreeRecipeId,
    commandOverrides,
    copyTreeSettings,
    branchPrefixMode,
    branchPrefixCustom,
    worktreePathPattern,
    currentProject,
    currentTerminalSettings,
    notificationOverrides,
  ]);
  currentProjectSnapshotRef.current = currentProjectSnapshot;

  useEffect(() => {
    if (!isOpen) {
      debouncedProjectSaveRef.current.cancel();
      prevProjectIdRef.current = null;
      lastSavedSnapshotRef.current = null;
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
      setGithubRemote(undefined);
      return;
    }

    const projectChanged =
      prevProjectIdRef.current !== null && projectId !== prevProjectIdRef.current;

    // When the project changes while the dialog is open, cancel any pending save
    // from the old project and defer initialization until fresh settings arrive.
    if (projectChanged) {
      debouncedProjectSaveRef.current.cancel();
      prevProjectIdRef.current = projectId;
      setProjectIsInitialized(false);
      return;
    }

    if (projectIsLoading || !projectSettings || !currentProject) return;
    if (projectIsInitialized) return;

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
    const initialGithubRemote = projectSettings.githubRemote;

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
    setGithubRemote(initialGithubRemote);

    lastSavedSnapshotRef.current = createProjectSettingsSnapshot(
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
      initialGithubRemote,
      initialWorktreePathPattern,
      initialTerminalSettings,
      initialNotificationOverrides,
      currentProject.color
    );
    prevProjectIdRef.current = projectId;
    setProjectIsInitialized(true);
  }, [projectSettings, isOpen, projectIsInitialized, currentProject, projectIsLoading, projectId]);

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
      if (!trimmedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey) || seenKeys.has(trimmedKey))
        continue;
      seenKeys.add(trimmedKey);
      envVarRecord[trimmedKey] = envVar.value;
    }

    const sanitizedPaths = excludedPaths.map((p) => p.trim()).filter(Boolean);
    const sanitizedCopyTreeSettings: CopyTreeSettings = {};
    if (copyTreeSettings.maxContextSize !== undefined)
      sanitizedCopyTreeSettings.maxContextSize = copyTreeSettings.maxContextSize;
    if (copyTreeSettings.maxFileSize !== undefined)
      sanitizedCopyTreeSettings.maxFileSize = copyTreeSettings.maxFileSize;
    if (copyTreeSettings.charLimit !== undefined)
      sanitizedCopyTreeSettings.charLimit = copyTreeSettings.charLimit;
    if (copyTreeSettings.strategy) sanitizedCopyTreeSettings.strategy = copyTreeSettings.strategy;
    if (copyTreeSettings.alwaysInclude && copyTreeSettings.alwaysInclude.length > 0) {
      sanitizedCopyTreeSettings.alwaysInclude = copyTreeSettings.alwaysInclude
        .map((p) => p.trim())
        .filter(Boolean);
      if (sanitizedCopyTreeSettings.alwaysInclude.length === 0)
        delete sanitizedCopyTreeSettings.alwaysInclude;
    }
    if (copyTreeSettings.alwaysExclude && copyTreeSettings.alwaysExclude.length > 0) {
      sanitizedCopyTreeSettings.alwaysExclude = copyTreeSettings.alwaysExclude
        .map((p) => p.trim())
        .filter(Boolean);
      if (sanitizedCopyTreeSettings.alwaysExclude.length === 0)
        delete sanitizedCopyTreeSettings.alwaysExclude;
    }
    const hasCopyTreeSettings = Object.keys(sanitizedCopyTreeSettings).length > 0;

    const sanitizedBranchPrefixCustom = branchPrefixCustom.trim();
    const effectivePrefixMode =
      branchPrefixMode === "custom" && !sanitizedBranchPrefixCustom ? "none" : branchPrefixMode;
    setProjectAutoSaveError(null);
    try {
      const trimmedName = projectName.trim() || currentProject.name;
      const identityChanged =
        trimmedName !== currentProject.name ||
        projectEmoji !== (currentProject.emoji || "🌲") ||
        projectColor !== currentProject.color;
      if (identityChanged) {
        await updateProject(projectId, {
          name: trimmedName,
          emoji: projectEmoji,
          color: projectColor,
        });
      }

      const sanitizedWorktreePathPattern = worktreePathPattern.trim() || undefined;
      if (sanitizedWorktreePathPattern) {
        const patternValidation = validatePathPattern(sanitizedWorktreePathPattern);
        if (!patternValidation.valid) {
          setProjectAutoSaveError("Invalid worktree path pattern — other settings were not saved");
          return;
        }
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
        branchPrefixCustom:
          effectivePrefixMode === "custom" ? sanitizedBranchPrefixCustom : undefined,
        githubRemote: githubRemote || undefined,
        worktreePathPattern: sanitizedWorktreePathPattern,
        terminalSettings: currentTerminalSettings,
        notificationOverrides:
          Object.keys(notificationOverrides).length > 0 ? notificationOverrides : undefined,
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
    debounce(() => {
      return projectPersistRef.current?.();
    }, 500)
  );

  useEffect(() => {
    if (!projectIsInitialized || !currentProjectSnapshot || !lastSavedSnapshotRef.current) return;
    if (areSnapshotsEqual(lastSavedSnapshotRef.current, currentProjectSnapshot)) return;
    debouncedProjectSaveRef.current();
  }, [currentProjectSnapshot, projectIsInitialized]);

  useEffect(() => {
    const save = debouncedProjectSaveRef.current;
    return () => {
      save.cancel();
    };
  }, []);

  const flush = async () => {
    debouncedProjectSaveRef.current.cancel();
    const current = currentProjectSnapshotRef.current;
    const last = lastSavedSnapshotRef.current;
    if (current && last && !areSnapshotsEqual(last, current)) {
      await projectPersistRef.current?.();
    }
  };

  return {
    projectAutoSaveError,
    projectName,
    setProjectName,
    projectEmoji,
    setProjectEmoji,
    projectColor,
    setProjectColor,
    runCommands,
    setRunCommands,
    environmentVariables,
    setEnvironmentVariables,
    excludedPaths,
    setExcludedPaths,
    projectIsInitialized,
    projectIconSvg,
    setProjectIconSvg,
    defaultWorktreeRecipeId,
    setDefaultWorktreeRecipeId,
    devServerCommand,
    setDevServerCommand,
    devServerLoadTimeout,
    setDevServerLoadTimeout,
    commandOverrides,
    setCommandOverrides,
    copyTreeSettings,
    setCopyTreeSettings,
    branchPrefixMode,
    setBranchPrefixMode,
    branchPrefixCustom,
    setBranchPrefixCustom,
    worktreePathPattern,
    setWorktreePathPattern,
    terminalShell,
    setTerminalShell,
    terminalShellArgs,
    setTerminalShellArgs,
    terminalDefaultCwd,
    setTerminalDefaultCwd,
    terminalScrollback,
    setTerminalScrollback,
    notificationOverrides,
    setNotificationOverrides,
    githubRemote,
    setGithubRemote,
    projectSettings,
    projectIsLoading,
    projectError,
    currentProject,
    enableInRepoSettings,
    disableInRepoSettings,
    recipes,
    recipesLoading,
    worktreeMap,
    worktrees,
    flush,
  };
}
