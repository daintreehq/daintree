import type { CommandOverride } from "@shared/types/commands";
import type { CopyTreeSettings, ProjectTerminalSettings } from "@shared/types/project";
import type { NotificationSettings } from "@shared/types/ipc/api";

export interface ProjectSettingsSnapshot {
  name: string;
  emoji: string;
  devServerCommand: string;
  devServerLoadTimeout: number | undefined;
  projectIconSvg: string | undefined;
  excludedPaths: string[];
  environmentVariables: Record<string, string>;
  runCommands: Array<{
    id: string;
    name: string;
    command: string;
    preferredLocation?: "dock" | "grid";
    preferredAutoRestart?: boolean;
  }>;
  defaultWorktreeRecipeId: string | undefined;
  commandOverrides: CommandOverride[];
  copyTreeSettings: CopyTreeSettings;
  branchPrefixMode: "none" | "username" | "custom";
  color: string | undefined;
  branchPrefixCustom: string;

  worktreePathPattern: string;
  terminalSettings: ProjectTerminalSettings | undefined;
  notificationOverrides: Partial<NotificationSettings> | undefined;
}

export interface EnvVar {
  id: string;
  key: string;
  value: string;
}

interface RunCommand {
  id: string;
  name: string;
  command: string;
  icon?: string;
  description?: string;
  preferredLocation?: "dock" | "grid";
  preferredAutoRestart?: boolean;
}

export function createProjectSettingsSnapshot(
  name: string,
  emoji: string,
  devServerCommand: string,
  projectIconSvg: string | undefined,
  excludedPaths: string[],
  environmentVariables: EnvVar[],
  runCommands: RunCommand[],
  defaultWorktreeRecipeId: string | undefined,
  commandOverrides: CommandOverride[],
  copyTreeSettings: CopyTreeSettings,
  branchPrefixMode: "none" | "username" | "custom" = "none",
  branchPrefixCustom: string = "",
  devServerLoadTimeout: number | undefined = undefined,
  worktreePathPattern: string = "",
  terminalSettings: ProjectTerminalSettings | undefined = undefined,
  notificationOverrides: Partial<NotificationSettings> | undefined = undefined,
  color: string | undefined = undefined
): ProjectSettingsSnapshot {
  const envVarRecord: Record<string, string> = {};
  const seenKeys = new Map<string, number>();

  for (const envVar of environmentVariables) {
    const trimmedKey = envVar.key.trim();
    if (!trimmedKey && !envVar.value.trim()) continue;

    let finalKey = trimmedKey || `__partial_${envVar.id}`;

    if (trimmedKey && seenKeys.has(trimmedKey)) {
      const count = seenKeys.get(trimmedKey)!;
      seenKeys.set(trimmedKey, count + 1);
      finalKey = `${trimmedKey}__dup_${count}`;
    } else if (trimmedKey) {
      seenKeys.set(trimmedKey, 1);
    }

    envVarRecord[finalKey] = envVar.value;
  }

  const sortedEnvKeys = Object.keys(envVarRecord).sort();
  const sortedEnvVars: Record<string, string> = {};
  for (const key of sortedEnvKeys) {
    sortedEnvVars[key] = envVarRecord[key];
  }

  const sanitizedRunCommands = runCommands
    .map((cmd) => ({
      id: cmd.id,
      name: cmd.name.trim(),
      command: cmd.command.trim(),
      preferredLocation: cmd.preferredLocation,
      preferredAutoRestart: cmd.preferredAutoRestart,
    }))
    .filter((cmd) => cmd.name || cmd.command);

  const sanitizedPaths = excludedPaths.map((p) => p.trim()).filter(Boolean);

  const sortedCommandOverrides = [...commandOverrides];

  // Normalize CopyTree settings
  const normalizedCopyTreeSettings: CopyTreeSettings = {
    ...copyTreeSettings,
    alwaysInclude: copyTreeSettings.alwaysInclude?.map((p) => p.trim()).filter(Boolean),
    alwaysExclude: copyTreeSettings.alwaysExclude?.map((p) => p.trim()).filter(Boolean),
  };

  // Clean up undefined/empty arrays if normalized
  if (normalizedCopyTreeSettings.alwaysInclude?.length === 0) {
    delete normalizedCopyTreeSettings.alwaysInclude;
  }
  if (normalizedCopyTreeSettings.alwaysExclude?.length === 0) {
    delete normalizedCopyTreeSettings.alwaysExclude;
  }

  const trimmedCustom = branchPrefixCustom.trim();
  // Mirrors the save-path logic: custom with empty prefix is equivalent to none
  const normalizedMode =
    (branchPrefixMode ?? "none") === "custom" && !trimmedCustom
      ? "none"
      : (branchPrefixMode ?? "none");
  return {
    name: name.trim(),
    emoji,
    devServerCommand: devServerCommand.trim(),
    devServerLoadTimeout,
    projectIconSvg,
    excludedPaths: sanitizedPaths,
    environmentVariables: sortedEnvVars,
    runCommands: sanitizedRunCommands,
    defaultWorktreeRecipeId,
    commandOverrides: sortedCommandOverrides,
    copyTreeSettings: normalizedCopyTreeSettings,
    color: color?.trim() || undefined,
    branchPrefixMode: normalizedMode,
    branchPrefixCustom: normalizedMode === "custom" ? trimmedCustom : "",
    worktreePathPattern: worktreePathPattern.trim(),
    terminalSettings: normalizeTerminalSettings(terminalSettings),
    notificationOverrides: normalizeNotificationOverrides(notificationOverrides),
  };
}

function normalizeTerminalSettings(
  ts: ProjectTerminalSettings | undefined
): ProjectTerminalSettings | undefined {
  if (!ts) return undefined;
  const result: ProjectTerminalSettings = {};
  if (ts.shell?.trim()) result.shell = ts.shell.trim();
  if (ts.shellArgs && ts.shellArgs.length > 0) result.shellArgs = [...ts.shellArgs];
  if (ts.defaultWorkingDirectory?.trim())
    result.defaultWorkingDirectory = ts.defaultWorkingDirectory.trim();
  if (ts.scrollbackLines !== undefined) result.scrollbackLines = ts.scrollbackLines;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeNotificationOverrides(
  overrides: Partial<NotificationSettings> | undefined
): Partial<NotificationSettings> | undefined {
  if (!overrides) return undefined;
  const result: Partial<NotificationSettings> = {};
  if (overrides.completedEnabled !== undefined)
    result.completedEnabled = overrides.completedEnabled;
  if (overrides.waitingEnabled !== undefined) result.waitingEnabled = overrides.waitingEnabled;
  if (overrides.soundEnabled !== undefined) result.soundEnabled = overrides.soundEnabled;
  if (overrides.completedSoundFile !== undefined)
    result.completedSoundFile = overrides.completedSoundFile;
  if (overrides.waitingSoundFile !== undefined)
    result.waitingSoundFile = overrides.waitingSoundFile;
  if (overrides.escalationSoundFile !== undefined)
    result.escalationSoundFile = overrides.escalationSoundFile;
  if (overrides.waitingEscalationEnabled !== undefined)
    result.waitingEscalationEnabled = overrides.waitingEscalationEnabled;
  if (overrides.waitingEscalationDelayMs !== undefined)
    result.waitingEscalationDelayMs = overrides.waitingEscalationDelayMs;
  return Object.keys(result).length > 0 ? result : undefined;
}

function areStringArraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function areSnapshotsEqual(a: ProjectSettingsSnapshot, b: ProjectSettingsSnapshot): boolean {
  if (a.name !== b.name) return false;
  if (a.emoji !== b.emoji) return false;
  if (a.color !== b.color) return false;
  if (a.devServerCommand !== b.devServerCommand) return false;
  if (a.devServerLoadTimeout !== b.devServerLoadTimeout) return false;
  if (a.projectIconSvg !== b.projectIconSvg) return false;
  if (a.defaultWorktreeRecipeId !== b.defaultWorktreeRecipeId) return false;

  if (a.excludedPaths.length !== b.excludedPaths.length) return false;
  for (let i = 0; i < a.excludedPaths.length; i++) {
    if (a.excludedPaths[i] !== b.excludedPaths[i]) return false;
  }

  const aEnvKeys = Object.keys(a.environmentVariables);
  const bEnvKeys = Object.keys(b.environmentVariables);
  if (aEnvKeys.length !== bEnvKeys.length) return false;
  for (const key of aEnvKeys) {
    if (a.environmentVariables[key] !== b.environmentVariables[key]) return false;
  }

  if (a.runCommands.length !== b.runCommands.length) return false;
  for (let i = 0; i < a.runCommands.length; i++) {
    if (
      a.runCommands[i].id !== b.runCommands[i].id ||
      a.runCommands[i].name !== b.runCommands[i].name ||
      a.runCommands[i].command !== b.runCommands[i].command ||
      a.runCommands[i].preferredLocation !== b.runCommands[i].preferredLocation ||
      a.runCommands[i].preferredAutoRestart !== b.runCommands[i].preferredAutoRestart
    ) {
      return false;
    }
  }

  if (a.commandOverrides.length !== b.commandOverrides.length) return false;
  for (let i = 0; i < a.commandOverrides.length; i++) {
    const aOverride = a.commandOverrides[i];
    const bOverride = b.commandOverrides[i];
    if (aOverride.commandId !== bOverride.commandId) return false;
    if (aOverride.disabled !== bOverride.disabled) return false;
    if (aOverride.prompt !== bOverride.prompt) return false;

    const aDefaults = aOverride.defaults || {};
    const bDefaults = bOverride.defaults || {};
    const aDefaultsStr = JSON.stringify(
      Object.keys(aDefaults)
        .sort()
        .map((k) => [k, aDefaults[k]])
    );
    const bDefaultsStr = JSON.stringify(
      Object.keys(bDefaults)
        .sort()
        .map((k) => [k, bDefaults[k]])
    );
    if (aDefaultsStr !== bDefaultsStr) return false;
  }

  // CopyTree settings comparison
  const aSettings = a.copyTreeSettings;
  const bSettings = b.copyTreeSettings;
  if (aSettings.maxContextSize !== bSettings.maxContextSize) return false;
  if (aSettings.maxFileSize !== bSettings.maxFileSize) return false;
  if (aSettings.charLimit !== bSettings.charLimit) return false;
  if (aSettings.strategy !== bSettings.strategy) return false;
  if (!areStringArraysEqual(aSettings.alwaysInclude, bSettings.alwaysInclude)) return false;
  if (!areStringArraysEqual(aSettings.alwaysExclude, bSettings.alwaysExclude)) return false;

  if (a.branchPrefixMode !== b.branchPrefixMode) return false;
  if (a.branchPrefixCustom !== b.branchPrefixCustom) return false;

  if (a.worktreePathPattern !== b.worktreePathPattern) return false;

  // Terminal settings comparison
  const aTs = a.terminalSettings;
  const bTs = b.terminalSettings;
  if (!aTs && !bTs) {
    // both undefined — equal
  } else if (!aTs || !bTs) {
    return false;
  } else {
    if (aTs.shell !== bTs.shell) return false;
    if (aTs.defaultWorkingDirectory !== bTs.defaultWorkingDirectory) return false;
    if (aTs.scrollbackLines !== bTs.scrollbackLines) return false;
    if (!areStringArraysEqual(aTs.shellArgs, bTs.shellArgs)) return false;
  }

  // Notification overrides comparison
  const aNotif = a.notificationOverrides;
  const bNotif = b.notificationOverrides;
  if (!aNotif && !bNotif) {
    // both undefined — equal
  } else if (!aNotif || !bNotif) {
    return false;
  } else {
    if (aNotif.completedEnabled !== bNotif.completedEnabled) return false;
    if (aNotif.waitingEnabled !== bNotif.waitingEnabled) return false;
    if (aNotif.soundEnabled !== bNotif.soundEnabled) return false;
    if (aNotif.completedSoundFile !== bNotif.completedSoundFile) return false;
    if (aNotif.waitingSoundFile !== bNotif.waitingSoundFile) return false;
    if (aNotif.escalationSoundFile !== bNotif.escalationSoundFile) return false;
    if (aNotif.waitingEscalationEnabled !== bNotif.waitingEscalationEnabled) return false;
    if (aNotif.waitingEscalationDelayMs !== bNotif.waitingEscalationDelayMs) return false;
  }

  return true;
}
