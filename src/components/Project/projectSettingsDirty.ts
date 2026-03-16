import type { CommandOverride } from "@shared/types/commands";
import type {
  CopyTreeSettings,
  ProjectTerminalSettings,
  ProjectMcpServerConfig,
} from "@shared/types/project";
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
  branchPrefixCustom: string;
  agentInstructions: string;
  worktreePathPattern: string;
  terminalSettings: ProjectTerminalSettings | undefined;
  mcpServers: Record<string, ProjectMcpServerConfig>;
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
  agentInstructions: string = "",
  worktreePathPattern: string = "",
  terminalSettings: ProjectTerminalSettings | undefined = undefined,
  mcpServers: Record<string, ProjectMcpServerConfig> = {},
  notificationOverrides: Partial<NotificationSettings> | undefined = undefined
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
    branchPrefixMode: normalizedMode,
    branchPrefixCustom: normalizedMode === "custom" ? trimmedCustom : "",
    agentInstructions: agentInstructions.trim(),
    worktreePathPattern: worktreePathPattern.trim(),
    terminalSettings: normalizeTerminalSettings(terminalSettings),
    mcpServers: normalizeMcpServers(mcpServers),
    notificationOverrides: normalizeNotificationOverrides(notificationOverrides),
  };
}

function normalizeMcpServers(
  servers: Record<string, ProjectMcpServerConfig>
): Record<string, ProjectMcpServerConfig> {
  const names = Object.keys(servers).sort();
  const result: Record<string, ProjectMcpServerConfig> = {};
  for (const name of names) {
    const s = servers[name];
    const normalized: ProjectMcpServerConfig = { command: s.command };
    if (s.args && s.args.length > 0) normalized.args = [...s.args];
    if (s.env && Object.keys(s.env).length > 0) {
      const sortedEnv: Record<string, string> = {};
      for (const k of Object.keys(s.env).sort()) {
        sortedEnv[k] = s.env[k];
      }
      normalized.env = sortedEnv;
    }
    if (s.cwd?.trim()) normalized.cwd = s.cwd.trim();
    result[name] = normalized;
  }
  return result;
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
  if (overrides.failedEnabled !== undefined) result.failedEnabled = overrides.failedEnabled;
  if (overrides.soundEnabled !== undefined) result.soundEnabled = overrides.soundEnabled;
  if (overrides.soundFile !== undefined) result.soundFile = overrides.soundFile;
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
  if (a.agentInstructions !== b.agentInstructions) return false;
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

  // MCP servers comparison
  const aMcpKeys = Object.keys(a.mcpServers);
  const bMcpKeys = Object.keys(b.mcpServers);
  if (aMcpKeys.length !== bMcpKeys.length) return false;
  for (const name of aMcpKeys) {
    const aServer = a.mcpServers[name];
    const bServer = b.mcpServers[name];
    if (!bServer) return false;
    if (aServer.command !== bServer.command) return false;
    if (aServer.cwd !== bServer.cwd) return false;
    if (!areStringArraysEqual(aServer.args, bServer.args)) return false;
    const aEnvKeys = Object.keys(aServer.env ?? {});
    const bEnvKeys = Object.keys(bServer.env ?? {});
    if (aEnvKeys.length !== bEnvKeys.length) return false;
    for (const k of aEnvKeys) {
      if (aServer.env![k] !== bServer.env?.[k]) return false;
    }
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
    if (aNotif.failedEnabled !== bNotif.failedEnabled) return false;
    if (aNotif.soundEnabled !== bNotif.soundEnabled) return false;
    if (aNotif.soundFile !== bNotif.soundFile) return false;
    if (aNotif.waitingEscalationEnabled !== bNotif.waitingEscalationEnabled) return false;
    if (aNotif.waitingEscalationDelayMs !== bNotif.waitingEscalationDelayMs) return false;
  }

  return true;
}
