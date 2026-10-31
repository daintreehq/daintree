import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { projectClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useRecipeStore } from "@/store/recipeStore";
import { logError } from "@/utils/logger";
import { debounce } from "@/utils/debounce";
import {
  createProjectSettingsSnapshot,
  areSnapshotsEqual,
  type EnvVar,
} from "@/components/Project/projectSettingsDirty";
import {
  applyFormEdits,
  buildTerminalSettings,
  hasFormEdits,
  toFormOwnedSettings,
  type FormOwnedSettings,
} from "@/components/Project/projectSettingsFormEdits";
import { formatShellArgs } from "@shared/utils/shellArgs";
import type { RunCommand, CopyTreeSettings } from "@/types";
import type {
  DaintreeMcpTier,
  ProjectTerminalSettings,
  ResourceEnvironment,
} from "@shared/types/project";
import { resolveDaintreeMcpTier } from "@shared/types/project";
import type { CommandOverride } from "@shared/types/commands";
import type { NotificationSettings } from "@shared/types/ipc/api";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** A form save that didn't go through: the draft stays in the form, and `message` says why. */
export interface ProjectSettingsSaveFailure {
  message: string;
}

type SaveOutcome = ProjectSettingsSaveFailure | undefined;

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
    refresh: refreshProjectSettings,
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
  const [turbopackEnabled, setTurbopackEnabled] = useState<boolean>(true);
  const [daintreeMcpTier, setDaintreeMcpTier] = useState<DaintreeMcpTier>("off");
  const [daintreeMcpSkipConfirmations, setDaintreeMcpSkipConfirmations] = useState(false);
  const [commandOverrides, setCommandOverrides] = useState<CommandOverride[]>([]);
  const [copyTreeSettings, setCopyTreeSettings] = useState<CopyTreeSettings>({});
  const [branchPrefixMode, setBranchPrefixMode] = useState<"none" | "username" | "custom">("none");
  const [branchPrefixCustom, setBranchPrefixCustom] = useState<string>("");
  const [worktreePathPattern, setWorktreePathPattern] = useState<string>("");
  const [terminalShell, setTerminalShell] = useState<string | undefined>(undefined);
  const [terminalShellArgs, setTerminalShellArgs] = useState<string | undefined>(undefined);
  const [terminalDefaultCwd, setTerminalDefaultCwd] = useState<string | undefined>(undefined);
  const [terminalScrollback, setTerminalScrollback] = useState<string | undefined>(undefined);
  const [notificationOverrides, setNotificationOverrides] = useState<Partial<NotificationSettings>>(
    {}
  );
  const [forgeRemote, setForgeRemote] = useState<string | undefined>(undefined);
  const [forgeProviderOverride, setForgeProviderOverride] = useState<string | null>(null);
  const [issueProviderOverride, setIssueProviderOverride] = useState<string | null>(null);
  const [resourceEnvironments, setResourceEnvironments] = useState<
    Record<string, ResourceEnvironment> | undefined
  >(undefined);
  const [activeResourceEnvironment, setActiveResourceEnvironment] = useState<string | undefined>(
    undefined
  );
  const [defaultWorktreeMode, setDefaultWorktreeMode] = useState<string | undefined>(undefined);
  const lastSavedSnapshotRef = useRef<ReturnType<typeof createProjectSettingsSnapshot> | null>(
    null
  );
  const currentProjectSnapshotRef = useRef<ReturnType<typeof createProjectSettingsSnapshot> | null>(
    null
  );
  // What the form last wrote, as stored values: a save sends only the fields
  // that differ from it, laid over the settings as they are on disk.
  const lastSavedFieldsRef = useRef<FormOwnedSettings | null>(null);
  const persistChainRef = useRef<Promise<SaveOutcome> | null>(null);
  // Set by a discard until the form seeds again. A close or save already under
  // way when the user discarded must not write the abandoned draft, nor bring
  // its error back.
  const discardingRef = useRef(false);
  // Retry bumps the attempt so the read made on open runs again.
  const [openReadAttempt, setOpenReadAttempt] = useState(0);
  const [settledOpenRead, setSettledOpenRead] = useState<{
    projectId: string;
    attempt: number;
  } | null>(null);
  const openReadSettled =
    !!projectId &&
    settledOpenRead?.projectId === projectId &&
    settledOpenRead.attempt === openReadAttempt;
  const prevProjectIdRef = useRef(projectId);
  const projectPersistRef =
    useRef<(options?: { force?: boolean }) => Promise<SaveOutcome>>(undefined);
  // Stable debounce instance initialized on mount. Uninitialized ref + mount
  // effect keeps the render pure so the React Compiler can optimize this hook.
  const debouncedProjectSaveRef = useRef<ReturnType<typeof debounce<[]>> | null>(null);
  useEffect(() => {
    // A failed autosave reports through projectAutoSaveError; the outcome is for
    // callers that can hold something open on it.
    debouncedProjectSaveRef.current = debounce(async () => {
      await projectPersistRef.current?.();
    }, 500);
    return () => {
      debouncedProjectSaveRef.current?.cancel();
      debouncedProjectSaveRef.current = null;
    };
  }, []);

  const { recipes, isLoading: recipesLoading } = useRecipeStore();
  const { worktreeMap, worktrees } = useWorktrees();

  const currentTerminalSettings = useMemo(
    (): ProjectTerminalSettings | undefined =>
      buildTerminalSettings(
        terminalShell,
        terminalShellArgs,
        terminalDefaultCwd,
        terminalScrollback,
        projectSettings?.terminalSettings?.scrollbackLines
      ),
    [terminalShell, terminalShellArgs, terminalDefaultCwd, terminalScrollback, projectSettings]
  );

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
      forgeRemote,
      worktreePathPattern,
      currentTerminalSettings,
      notificationOverrides,
      projectColor,
      resourceEnvironments,
      activeResourceEnvironment,
      defaultWorktreeMode,
      turbopackEnabled,
      daintreeMcpTier,
      forgeProviderOverride,
      daintreeMcpSkipConfirmations,
      issueProviderOverride
    );
  }, [
    projectName,
    projectEmoji,
    projectColor,
    devServerCommand,
    devServerLoadTimeout,
    forgeRemote,
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
    resourceEnvironments,
    activeResourceEnvironment,
    defaultWorktreeMode,
    turbopackEnabled,
    daintreeMcpTier,
    forgeProviderOverride,
    daintreeMcpSkipConfirmations,
    issueProviderOverride,
  ]);
  // Layout effect, not passive: callers such as EnvironmentVariablesEditor push
  // new values and invoke flush() in the same tick, and flush() reads this ref
  // to decide whether anything changed. A passive effect lands after that read,
  // so the edit would look clean and be dropped.
  useLayoutEffect(() => {
    currentProjectSnapshotRef.current = currentProjectSnapshot;
  }, [currentProjectSnapshot]);

  useEffect(() => {
    if (isOpen && projectId !== prevProjectIdRef.current) {
      setProjectIsInitialized(false);
    }
    prevProjectIdRef.current = projectId;
  }, [projectId, isOpen]);

  // The cached settings are read once per view, and writers outside this form
  // (the MCP tier banner, a toast's silence action) save to disk alone. Seed
  // from a read made after the dialog opened, and after any save the last
  // session left in flight.
  useEffect(() => {
    if (!isOpen || !projectId) return;
    let cancelled = false;
    void Promise.resolve(persistChainRef.current)
      .then(() => refreshProjectSettings())
      // A failed read reports through projectError and leaves the cache as it was.
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) setSettledOpenRead({ projectId, attempt: openReadAttempt });
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId, refreshProjectSettings, openReadAttempt]);

  const retryProjectSettingsRead = async () => {
    setOpenReadAttempt((attempt) => attempt + 1);
  };

  // Gives up an edit that won't save. The form seeds again from a fresh read, so
  // it holds what main stores and a close after it has nothing left to write.
  const discardUnsavedChanges = () => {
    discardingRef.current = true;
    debouncedProjectSaveRef.current?.cancel();
    setProjectAutoSaveError(null);
    setProjectIsInitialized(false);
    setOpenReadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    if (!isOpen) {
      debouncedProjectSaveRef.current?.cancel();
      setProjectIsInitialized(false);
      setEnvironmentVariables([]);
      setProjectIconSvg(undefined);
      setDefaultWorktreeRecipeId(undefined);
      setDevServerCommand("");
      setDevServerLoadTimeout(undefined);
      setTurbopackEnabled(true);
      setDaintreeMcpTier("off");
      setDaintreeMcpSkipConfirmations(false);
      setCommandOverrides([]);
      setCopyTreeSettings({});
      setProjectAutoSaveError(null);
      setProjectColor(undefined);
      setBranchPrefixMode("none");
      setBranchPrefixCustom("");
      setWorktreePathPattern("");
      setTerminalShell(undefined);
      setTerminalShellArgs(undefined);
      setTerminalDefaultCwd(undefined);
      setTerminalScrollback(undefined);
      setNotificationOverrides({});
      setForgeRemote(undefined);
      setForgeProviderOverride(null);
      setIssueProviderOverride(null);
      setResourceEnvironments(undefined);
      setActiveResourceEnvironment(undefined);
      setDefaultWorktreeMode(undefined);
      setSettledOpenRead(null);
      lastSavedSnapshotRef.current = null;
      lastSavedFieldsRef.current = null;
      discardingRef.current = false;
      return;
    }

    if (projectIsLoading || !projectSettings || !currentProject) return;
    // A failed read leaves only the cache, which may predate what main stores;
    // the error banner's Retry seeds once a read succeeds.
    if (!openReadSettled || projectError) return;
    if (projectIsInitialized) return;

    const initialRunCommands = projectSettings.runCommands || [];
    const envVars = projectSettings.environmentVariables || {};
    const initialEnvVars = Object.entries(envVars).map(([key, value]) => ({
      id: `env-${crypto.randomUUID()}`,
      key,
      value,
    }));
    const initialExcludedPaths = projectSettings.excludedPaths || [];
    const initialProjectIconSvg = projectSettings.projectIconSvg;
    const initialDefaultWorktreeRecipeId = projectSettings.defaultWorktreeRecipeId;
    const initialDevServerCommand = projectSettings.devServerCommand || "";
    const initialDevServerLoadTimeout = projectSettings.devServerLoadTimeout;
    const initialTurbopackEnabled = projectSettings.turbopackEnabled ?? true;
    const initialDaintreeMcpTier = resolveDaintreeMcpTier(projectSettings);
    const initialDaintreeMcpSkipConfirmations =
      projectSettings.daintreeMcpSkipConfirmations === true;
    const initialCommandOverrides = projectSettings.commandOverrides || [];
    const initialCopyTreeSettings = projectSettings.copyTreeSettings || {};
    const initialBranchPrefixMode = projectSettings.branchPrefixMode ?? "none";
    const initialBranchPrefixCustom = projectSettings.branchPrefixCustom ?? "";
    const initialWorktreePathPattern = projectSettings.worktreePathPattern ?? "";
    const initialTerminalSettings = projectSettings.terminalSettings;
    const initialNotificationOverrides = projectSettings.notificationOverrides ?? {};
    const initialForgeRemote = projectSettings.forgeRemote;
    const initialForgeProviderOverride = projectSettings.forgeProviderOverride ?? null;
    const initialIssueProviderOverride = projectSettings.issueProviderOverride ?? null;
    // resourceEnvironment → resourceEnvironments migration is owned by the
    // main-process codec (electron/services/projectSettingsCodec.ts), so by
    // the time settings reach the renderer they are already canonical.
    const initialResourceEnvironments: Record<string, ResourceEnvironment> | undefined =
      projectSettings.resourceEnvironments;
    let initialActiveResourceEnvironment: string | undefined =
      projectSettings.activeResourceEnvironment;
    if (
      initialResourceEnvironments &&
      initialActiveResourceEnvironment &&
      !initialResourceEnvironments[initialActiveResourceEnvironment]
    ) {
      const keys = Object.keys(initialResourceEnvironments);
      initialActiveResourceEnvironment = keys.length > 0 ? keys[0] : "default";
    }
    const initialDefaultWorktreeMode = projectSettings.defaultWorktreeMode;
    const initialTerminalShellArgs = initialTerminalSettings?.shellArgs
      ? formatShellArgs(initialTerminalSettings.shellArgs)
      : undefined;
    const initialTerminalScrollback =
      initialTerminalSettings?.scrollbackLines !== undefined
        ? String(initialTerminalSettings.scrollbackLines)
        : undefined;

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
    setTurbopackEnabled(initialTurbopackEnabled);
    setDaintreeMcpTier(initialDaintreeMcpTier);
    setDaintreeMcpSkipConfirmations(initialDaintreeMcpSkipConfirmations);
    setCommandOverrides(initialCommandOverrides);
    setCopyTreeSettings(initialCopyTreeSettings);
    setBranchPrefixMode(initialBranchPrefixMode);
    setBranchPrefixCustom(initialBranchPrefixCustom);
    setWorktreePathPattern(initialWorktreePathPattern);
    setTerminalShell(initialTerminalSettings?.shell);
    setTerminalShellArgs(initialTerminalShellArgs);
    setTerminalDefaultCwd(initialTerminalSettings?.defaultWorkingDirectory);
    setTerminalScrollback(initialTerminalScrollback);
    setNotificationOverrides(initialNotificationOverrides);
    setForgeRemote(initialForgeRemote);
    setForgeProviderOverride(initialForgeProviderOverride);
    setIssueProviderOverride(initialIssueProviderOverride);
    setResourceEnvironments(initialResourceEnvironments);
    setActiveResourceEnvironment(initialActiveResourceEnvironment);
    setDefaultWorktreeMode(initialDefaultWorktreeMode);

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
      initialForgeRemote,
      initialWorktreePathPattern,
      initialTerminalSettings,
      initialNotificationOverrides,
      currentProject.color,
      initialResourceEnvironments,
      initialActiveResourceEnvironment,
      initialDefaultWorktreeMode,
      initialTurbopackEnabled,
      initialDaintreeMcpTier,
      initialForgeProviderOverride,
      initialDaintreeMcpSkipConfirmations,
      initialIssueProviderOverride
    );
    lastSavedFieldsRef.current = toFormOwnedSettings(
      {
        runCommands: initialRunCommands,
        environmentVariables: initialEnvVars,
        excludedPaths: initialExcludedPaths,
        projectIconSvg: initialProjectIconSvg,
        defaultWorktreeRecipeId: initialDefaultWorktreeRecipeId,
        devServerCommand: initialDevServerCommand,
        devServerLoadTimeout: initialDevServerLoadTimeout,
        turbopackEnabled: initialTurbopackEnabled,
        daintreeMcpTier: initialDaintreeMcpTier,
        daintreeMcpSkipConfirmations: initialDaintreeMcpSkipConfirmations,
        commandOverrides: initialCommandOverrides,
        copyTreeSettings: initialCopyTreeSettings,
        branchPrefixMode: initialBranchPrefixMode,
        branchPrefixCustom: initialBranchPrefixCustom,
        forgeRemote: initialForgeRemote,
        forgeProviderOverride: initialForgeProviderOverride,
        issueProviderOverride: initialIssueProviderOverride,
        worktreePathPattern: initialWorktreePathPattern,
        terminalShell: initialTerminalSettings?.shell,
        terminalShellArgs: initialTerminalShellArgs,
        terminalDefaultCwd: initialTerminalSettings?.defaultWorkingDirectory,
        terminalScrollback: initialTerminalScrollback,
        notificationOverrides: initialNotificationOverrides,
        resourceEnvironments: initialResourceEnvironments,
        activeResourceEnvironment: initialActiveResourceEnvironment,
        defaultWorktreeMode: initialDefaultWorktreeMode,
      },
      null
    );
    discardingRef.current = false;
    setProjectIsInitialized(true);
  }, [
    projectSettings,
    isOpen,
    projectIsInitialized,
    currentProject,
    projectIsLoading,
    projectId,
    openReadSettled,
    projectError,
  ]);

  const persistDraft = async (force: boolean): Promise<SaveOutcome> => {
    if (!projectSettings || !currentProject || !projectId || discardingRef.current) {
      return undefined;
    }

    const baseline = lastSavedFieldsRef.current;
    const draft = toFormOwnedSettings(
      {
        runCommands,
        environmentVariables,
        excludedPaths,
        projectIconSvg,
        defaultWorktreeRecipeId,
        devServerCommand,
        devServerLoadTimeout,
        turbopackEnabled,
        daintreeMcpTier,
        daintreeMcpSkipConfirmations,
        commandOverrides,
        copyTreeSettings,
        branchPrefixMode,
        branchPrefixCustom,
        forgeRemote,
        forgeProviderOverride,
        issueProviderOverride,
        worktreePathPattern,
        terminalShell,
        terminalShellArgs,
        terminalDefaultCwd,
        terminalScrollback,
        notificationOverrides,
        resourceEnvironments,
        activeResourceEnvironment,
        defaultWorktreeMode,
      },
      baseline
    );
    // The error stays up through a retry, so the banner (and the Retry a held
    // close focused) isn't torn down and rebuilt on every attempt.
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

      // Lay the edits over a fresh read, not the cache: other writers save to
      // disk without touching the cache, and a field this form never changed
      // must keep whatever they stored (#15573).
      if (force || hasFormEdits(baseline, draft)) {
        const stored = await projectClient.getSettings(projectId);
        await saveProjectSettings(applyFormEdits(stored, baseline, draft));
      }

      lastSavedFieldsRef.current = draft;
      if (currentProjectSnapshot) {
        lastSavedSnapshotRef.current = currentProjectSnapshot;
      }
      setProjectAutoSaveError(null);
      return undefined;
    } catch (err) {
      logError("Failed to auto-save project settings", err);
      if (discardingRef.current) return undefined;
      const message = formatErrorMessage(err, "Failed to save settings");
      setProjectAutoSaveError(message);
      return { message };
    }
  };

  // One save at a time: each diffs against the baseline the previous one left.
  const projectPersist = (options?: { force?: boolean }) => {
    const run = Promise.resolve(persistChainRef.current).then(() =>
      persistDraft(options?.force === true)
    );
    persistChainRef.current = run;
    return run;
  };

  // projectPersist is recreated each render; sync it to the ref so the
  // debounced wrapper always calls the latest closure. Layout phase for the
  // same reason as currentProjectSnapshotRef above.
  useLayoutEffect(() => {
    projectPersistRef.current = projectPersist;
  });

  useEffect(() => {
    if (!projectIsInitialized || !currentProjectSnapshot || !lastSavedSnapshotRef.current) {
      return;
    }
    const equal = areSnapshotsEqual(lastSavedSnapshotRef.current, currentProjectSnapshot);
    if (equal) return;
    debouncedProjectSaveRef.current?.();
  }, [currentProjectSnapshot, projectIsInitialized]);

  // Explicit user-initiated save. Persists unconditionally, so a re-save of
  // unchanged values still reaches main — the environment-variable migration
  // button relies on that to relocate insecure values. Resolves with the failure
  // rather than rejecting, the way flush does.
  const saveNow = async (): Promise<SaveOutcome> => {
    await debouncedProjectSaveRef.current?.flush();
    if (!projectIsInitialized || !projectPersistRef.current) return undefined;
    return projectPersistRef.current({ force: true });
  };

  // Lifecycle save, run on dialog close and on WebContentsView detach. Unlike
  // saveNow it must not write when the form is clean: nothing was edited, so
  // there is nothing for a write to say (#12326). Resolves with the failure when
  // the draft couldn't be saved, so a close can stay open on it; a detach can't,
  // and ignores it.
  const flush = async (): Promise<SaveOutcome> => {
    // First drain any pending debounced save — that also settles an in-flight
    // one, so the snapshot comparison below sees its result.
    await debouncedProjectSaveRef.current?.flush();
    if (!projectIsInitialized || !projectPersistRef.current) return undefined;
    const lastSaved = lastSavedSnapshotRef.current;
    const current = currentProjectSnapshotRef.current;
    // Missing either snapshot means we cannot prove the form is clean; persist
    // rather than risk losing an edit on close.
    if (lastSaved && current && areSnapshotsEqual(lastSaved, current)) return undefined;
    return projectPersistRef.current();
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
    turbopackEnabled,
    setTurbopackEnabled,
    daintreeMcpTier,
    setDaintreeMcpTier,
    daintreeMcpSkipConfirmations,
    setDaintreeMcpSkipConfirmations,
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
    forgeRemote,
    setForgeRemote,
    forgeProviderOverride,
    setForgeProviderOverride,
    issueProviderOverride,
    setIssueProviderOverride,
    resourceEnvironments,
    setResourceEnvironments,
    activeResourceEnvironment,
    setActiveResourceEnvironment,
    defaultWorktreeMode,
    setDefaultWorktreeMode,
    projectSettings,
    // A revalidation leaves the store's own flag down, so the read made on open
    // reports here or the dialog never shows it is still loading.
    projectIsLoading: projectIsLoading || (isOpen && !!projectId && !openReadSettled),
    projectError,
    refreshProjectSettings: retryProjectSettingsRead,
    currentProject,
    enableInRepoSettings,
    disableInRepoSettings,
    recipes,
    recipesLoading,
    worktreeMap,
    worktrees,
    flush,
    saveNow,
    discardUnsavedChanges,
  };
}

export type ProjectSettingsFormContext = ReturnType<typeof useProjectSettingsForm>;
