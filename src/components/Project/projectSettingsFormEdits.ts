import type { CopyTreeSettings, ProjectSettings, RunCommand } from "@/types";
import type {
  DaintreeMcpTier,
  ProjectTerminalSettings,
  ResourceEnvironment,
} from "@shared/types/project";
import type { NotificationSettings } from "@shared/types/ipc/api";
import { SCROLLBACK_MIN, SCROLLBACK_MAX } from "@shared/config/scrollback";
import { deepEqualIgnoringUndefined } from "@shared/utils/layoutMerge";
import { validatePathPattern } from "@shared/utils/pathPattern";
import { parseShellArgs } from "@shared/utils/shellArgs";
import type { EnvVar } from "./projectSettingsDirty";

export interface ProjectSettingsFormValues {
  runCommands: RunCommand[];
  environmentVariables: EnvVar[];
  excludedPaths: string[];
  projectIconSvg: string | undefined;
  defaultWorktreeRecipeId: string | undefined;
  devServerCommand: string;
  devServerLoadTimeout: number | undefined;
  turbopackEnabled: boolean;
  daintreeMcpTier: DaintreeMcpTier;
  daintreeMcpSkipConfirmations: boolean;
  copyTreeSettings: CopyTreeSettings;
  branchPrefixMode: "none" | "username" | "custom";
  branchPrefixCustom: string;
  forgeRemote: string | undefined;
  forgeProviderOverride: string | null;
  issueProviderOverride: string | null;
  worktreePathPattern: string;
  terminalShell: string | undefined;
  terminalShellArgs: string | undefined;
  terminalDefaultCwd: string | undefined;
  terminalScrollback: string | undefined;
  notificationOverrides: Partial<NotificationSettings>;
  resourceEnvironments: Record<string, ResourceEnvironment> | undefined;
  activeResourceEnvironment: string | undefined;
  defaultWorktreeMode: string | undefined;
}

type FormOwnedField =
  | "runCommands"
  | "environmentVariables"
  | "excludedPaths"
  | "projectIconSvg"
  | "defaultWorktreeRecipeId"
  | "devServerCommand"
  | "devServerLoadTimeout"
  | "turbopackEnabled"
  | "daintreeMcpTier"
  | "daintreeMcpSkipConfirmations"
  | "copyTreeSettings"
  | "branchPrefixMode"
  | "branchPrefixCustom"
  | "forgeRemote"
  | "forgeProviderOverride"
  | "issueProviderOverride"
  | "worktreePathPattern"
  | "terminalSettings"
  | "notificationOverrides"
  | "resourceEnvironments"
  | "activeResourceEnvironment"
  | "defaultWorktreeMode";

/** The stored settings fields the project settings form edits, every one present. */
export type FormOwnedSettings = { [K in FormOwnedField]: ProjectSettings[K] };

// Record-valued fields merge key by key, so changing one notification kind or
// variable leaves the keys another writer set in the same record alone.
const KEYED_FIELDS: ReadonlySet<FormOwnedField> = new Set<FormOwnedField>([
  "environmentVariables",
  "notificationOverrides",
  "terminalSettings",
  "resourceEnvironments",
  "copyTreeSettings",
]);

export function buildTerminalSettings(
  shell: string | undefined,
  shellArgs: string | undefined,
  defaultCwd: string | undefined,
  scrollback: string | undefined,
  fallbackScrollback: number | undefined
): ProjectTerminalSettings | undefined {
  const result: ProjectTerminalSettings = {};
  if (shell !== undefined && shell.trim()) result.shell = shell.trim();
  if (shellArgs !== undefined) {
    const parsed = parseShellArgs(shellArgs);
    if (parsed.length > 0) result.shellArgs = parsed;
  }
  if (defaultCwd !== undefined && defaultCwd.trim())
    result.defaultWorkingDirectory = defaultCwd.trim();
  if (scrollback !== undefined && scrollback.trim()) {
    const num = Number(scrollback);
    if (Number.isFinite(num) && num >= SCROLLBACK_MIN && num <= SCROLLBACK_MAX) {
      result.scrollbackLines = Math.trunc(num);
    } else if (fallbackScrollback !== undefined) {
      // Invalid in-flight input must not silently wipe an existing valid
      // override — preserve the last saved value until the user types a
      // valid number or resets the field.
      result.scrollbackLines = fallbackScrollback;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * The form's values as they would be stored. Invalid drafts (a path pattern
 * missing its token, an out-of-range scrollback) keep `saved`'s value, so they
 * never count as an edit and unrelated edits still save.
 */
export function toFormOwnedSettings(
  values: ProjectSettingsFormValues,
  saved: FormOwnedSettings | null
): FormOwnedSettings {
  const runCommands = values.runCommands
    .map((cmd) => ({ ...cmd, name: cmd.name.trim(), command: cmd.command.trim() }))
    .filter((cmd) => cmd.name && cmd.command);

  const environmentVariables: Record<string, string> = {};
  const seenKeys = new Set<string>();
  for (const envVar of values.environmentVariables) {
    const key = envVar.key.trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    environmentVariables[key] = envVar.value;
  }

  const excludedPaths = values.excludedPaths.map((p) => p.trim()).filter(Boolean);

  const { copyTreeSettings } = values;
  const sanitizedCopyTreeSettings: CopyTreeSettings = {};
  if (copyTreeSettings.maxContextSize !== undefined)
    sanitizedCopyTreeSettings.maxContextSize = copyTreeSettings.maxContextSize;
  if (copyTreeSettings.maxFileSize !== undefined)
    sanitizedCopyTreeSettings.maxFileSize = copyTreeSettings.maxFileSize;
  if (copyTreeSettings.charLimit !== undefined)
    sanitizedCopyTreeSettings.charLimit = copyTreeSettings.charLimit;
  if (copyTreeSettings.strategy) sanitizedCopyTreeSettings.strategy = copyTreeSettings.strategy;
  const alwaysInclude = copyTreeSettings.alwaysInclude?.map((p) => p.trim()).filter(Boolean);
  if (alwaysInclude && alwaysInclude.length > 0)
    sanitizedCopyTreeSettings.alwaysInclude = alwaysInclude;
  const alwaysExclude = copyTreeSettings.alwaysExclude?.map((p) => p.trim()).filter(Boolean);
  if (alwaysExclude && alwaysExclude.length > 0)
    sanitizedCopyTreeSettings.alwaysExclude = alwaysExclude;

  const branchPrefixCustom = values.branchPrefixCustom.trim();
  const branchPrefixMode =
    values.branchPrefixMode === "custom" && !branchPrefixCustom ? "none" : values.branchPrefixMode;

  const draftPathPattern = values.worktreePathPattern.trim() || undefined;
  const pathPatternIsValid = !draftPathPattern || validatePathPattern(draftPathPattern).valid;

  return {
    runCommands,
    environmentVariables:
      Object.keys(environmentVariables).length > 0 ? environmentVariables : undefined,
    excludedPaths: excludedPaths.length > 0 ? excludedPaths : undefined,
    projectIconSvg: values.projectIconSvg,
    defaultWorktreeRecipeId: values.defaultWorktreeRecipeId,
    devServerCommand: values.devServerCommand.trim() || undefined,
    devServerLoadTimeout: values.devServerLoadTimeout,
    turbopackEnabled: values.turbopackEnabled === true ? undefined : false,
    daintreeMcpTier: values.daintreeMcpTier !== "off" ? values.daintreeMcpTier : undefined,
    daintreeMcpSkipConfirmations: values.daintreeMcpSkipConfirmations ? true : undefined,
    copyTreeSettings:
      Object.keys(sanitizedCopyTreeSettings).length > 0 ? sanitizedCopyTreeSettings : undefined,
    branchPrefixMode: branchPrefixMode !== "none" ? branchPrefixMode : undefined,
    branchPrefixCustom: branchPrefixMode === "custom" ? branchPrefixCustom : undefined,
    forgeRemote: values.forgeRemote || undefined,
    forgeProviderOverride: values.forgeProviderOverride ?? undefined,
    issueProviderOverride: values.issueProviderOverride ?? undefined,
    worktreePathPattern: pathPatternIsValid ? draftPathPattern : saved?.worktreePathPattern,
    terminalSettings: buildTerminalSettings(
      values.terminalShell,
      values.terminalShellArgs,
      values.terminalDefaultCwd,
      values.terminalScrollback,
      saved?.terminalSettings?.scrollbackLines
    ),
    notificationOverrides:
      Object.keys(values.notificationOverrides).length > 0
        ? values.notificationOverrides
        : undefined,
    resourceEnvironments: values.resourceEnvironments,
    activeResourceEnvironment: values.activeResourceEnvironment,
    defaultWorktreeMode: values.defaultWorktreeMode,
  };
}

function editedFields(
  baseline: FormOwnedSettings | null,
  draft: FormOwnedSettings
): FormOwnedField[] {
  return (Object.keys(draft) as FormOwnedField[]).filter(
    (field) => !deepEqualIgnoringUndefined(baseline?.[field], draft[field])
  );
}

export function hasFormEdits(
  baseline: FormOwnedSettings | null,
  draft: FormOwnedSettings
): boolean {
  return editedFields(baseline, draft).length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// Own properties only: a variable named `constructor` or `toString` that is
// absent from a record must not read back as Object.prototype's function.
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function mergeKeyEdits(stored: unknown, baseline: unknown, draft: unknown): unknown {
  const before = asRecord(baseline);
  const after = asRecord(draft);
  const merged: Record<string, unknown> = Object.assign(Object.create(null), asRecord(stored));
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = ownValue(after, key);
    if (deepEqualIgnoringUndefined(ownValue(before, key), next)) continue;
    if (next === undefined) delete merged[key];
    else merged[key] = next;
  }
  return Object.keys(merged).length > 0 ? { ...merged } : undefined;
}

/**
 * Lays the fields the form changed since `baseline` over `stored`, the
 * settings as they are now. A field the user changed takes the form's value,
 * even when another writer changed it too; every other field keeps what is
 * stored, so a value written outside the form survives the save.
 */
export function applyFormEdits(
  stored: ProjectSettings,
  baseline: FormOwnedSettings | null,
  draft: FormOwnedSettings
): ProjectSettings {
  const next: Record<string, unknown> = { ...stored };
  for (const field of editedFields(baseline, draft)) {
    next[field] = KEYED_FIELDS.has(field)
      ? mergeKeyEdits(stored[field], baseline?.[field], draft[field])
      : draft[field];
  }
  return {
    ...(next as unknown as ProjectSettings),
    // The legacy fields were migrated into their canonical ones when `stored`
    // was decoded, and Main moves every sensitive variable into secure storage
    // on each write, so none of these outlives the save.
    exposeDaintreeMcpToAgents: undefined,
    resourceEnvironment: undefined,
    insecureEnvironmentVariables: undefined,
  };
}
