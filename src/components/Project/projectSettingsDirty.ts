import type { CommandOverride } from "@shared/types/commands";
import type { CopyTreeSettings } from "@shared/types/domain";

export interface ProjectSettingsSnapshot {
  name: string;
  emoji: string;
  devServerCommand: string;
  projectIconSvg: string | undefined;
  excludedPaths: string[];
  environmentVariables: Record<string, string>;
  runCommands: Array<{ id: string; name: string; command: string }>;
  defaultWorktreeRecipeId: string | undefined;
  commandOverrides: CommandOverride[];
  copyTreeSettings: CopyTreeSettings;
}

interface EnvVar {
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
  copyTreeSettings: CopyTreeSettings
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

  return {
    name: name.trim(),
    emoji,
    devServerCommand: devServerCommand.trim(),
    projectIconSvg,
    excludedPaths: sanitizedPaths,
    environmentVariables: sortedEnvVars,
    runCommands: sanitizedRunCommands,
    defaultWorktreeRecipeId,
    commandOverrides: sortedCommandOverrides,
    copyTreeSettings: normalizedCopyTreeSettings,
  };
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
      a.runCommands[i].command !== b.runCommands[i].command
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

  return true;
}
