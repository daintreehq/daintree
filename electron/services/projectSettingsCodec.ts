/**
 * Central authority for ProjectSettings schema, version envelope, migrations,
 * decoding, and encoding. All callers route through here so the shape, the
 * legacy field migrations, and the on-disk envelope are defined once.
 *
 * Decode is total: any unknown input produces a `ProjectSettingsDecodeResult`
 * without throwing. The Zod save schema gates IPC writes from the renderer.
 *
 * Side-effects (file I/O, SVG sanitization, secure env storage) belong to
 * ProjectSettingsManager — this module is pure.
 */

import path from "path";
import { z } from "zod";
import type { EditorConfig } from "../../shared/types/editor.js";
import { normalizeScrollbackLines } from "../../shared/config/scrollback.js";
import type {
  CopyTreeSettings,
  DaintreeMcpTier,
  FleetSavedScope,
  PredicateFleetSavedScope,
  ProjectSettings,
  ProjectTerminalSettings,
  ResourceEnvironment,
  SnapshotFleetSavedScope,
} from "../../shared/types/project.js";
import type { CommandOverride } from "../../shared/types/commands.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import { normalizeProviderId } from "../../shared/utils/forgeProviderIds.js";

export const PROJECT_SETTINGS_SCHEMA_VERSION = 1;

/**
 * Outcome of decoding an unknown blob into ProjectSettings. `decode` never
 * throws — corruption surfaces here rather than via exceptions so callers can
 * react (quarantine + user notification) rather than silently fall back to
 * defaults.
 */
export type ProjectSettingsDecodeResult =
  | { ok: true; settings: ProjectSettings }
  | { ok: false; reason: "future-version"; onDiskVersion: number };

const ALLOWED_NOTIFICATION_SOUNDS = [
  "chime.wav",
  "ping.wav",
  "complete.wav",
  "waiting.wav",
  "error.wav",
  "pulse.wav",
];

const VALID_PREDICATE_SCOPES = new Set(["current", "all"]);
const VALID_PREDICATE_STATES = new Set(["all", "working", "waiting", "finished"]);
const VALID_MCP_TIERS = new Set<DaintreeMcpTier>(["off", "workbench", "action", "system"]);

function decodeTerminalSettings(raw: unknown): ProjectTerminalSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const result: ProjectTerminalSettings = {};

  if (typeof obj.shell === "string" && obj.shell.trim()) {
    const trimmedShell = obj.shell.trim();
    if (path.isAbsolute(trimmedShell)) {
      result.shell = trimmedShell;
    } else {
      console.warn(
        `[projectSettingsCodec] decodeTerminalSettings: dropping non-absolute shell path: "${trimmedShell}"`
      );
    }
  }
  if (Array.isArray(obj.shellArgs)) {
    const args = obj.shellArgs.filter((a): a is string => typeof a === "string");
    if (args.length > 0) result.shellArgs = args;
  }
  if (
    typeof obj.defaultWorkingDirectory === "string" &&
    obj.defaultWorkingDirectory.trim() &&
    path.isAbsolute(obj.defaultWorkingDirectory.trim())
  ) {
    result.defaultWorkingDirectory = obj.defaultWorkingDirectory.trim();
  }
  if (typeof obj.scrollbackLines === "number" || typeof obj.scrollbackLines === "string") {
    result.scrollbackLines = normalizeScrollbackLines(obj.scrollbackLines);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function decodeNotificationOverrides(raw: unknown): Partial<NotificationSettings> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Partial<NotificationSettings> = {};

  if (typeof obj.completedEnabled === "boolean") result.completedEnabled = obj.completedEnabled;
  if (typeof obj.waitingEnabled === "boolean") result.waitingEnabled = obj.waitingEnabled;
  if (typeof obj.soundEnabled === "boolean") result.soundEnabled = obj.soundEnabled;

  if (
    typeof obj.completedSoundFile === "string" &&
    ALLOWED_NOTIFICATION_SOUNDS.includes(obj.completedSoundFile)
  ) {
    result.completedSoundFile = obj.completedSoundFile;
  } else if (
    typeof obj.soundFile === "string" &&
    ALLOWED_NOTIFICATION_SOUNDS.includes(obj.soundFile)
  ) {
    // Legacy alias from a previous settings shape.
    result.completedSoundFile = obj.soundFile;
  }
  if (
    typeof obj.waitingSoundFile === "string" &&
    ALLOWED_NOTIFICATION_SOUNDS.includes(obj.waitingSoundFile)
  ) {
    result.waitingSoundFile = obj.waitingSoundFile;
  }
  if (
    typeof obj.escalationSoundFile === "string" &&
    ALLOWED_NOTIFICATION_SOUNDS.includes(obj.escalationSoundFile)
  ) {
    result.escalationSoundFile = obj.escalationSoundFile;
  }
  if (typeof obj.waitingEscalationEnabled === "boolean") {
    result.waitingEscalationEnabled = obj.waitingEscalationEnabled;
  }
  if (
    typeof obj.waitingEscalationDelayMs === "number" &&
    Number.isFinite(obj.waitingEscalationDelayMs)
  ) {
    result.waitingEscalationDelayMs = Math.max(
      30_000,
      Math.min(3_600_000, obj.waitingEscalationDelayMs)
    );
  }
  if (typeof obj.workingPulseEnabled === "boolean") {
    result.workingPulseEnabled = obj.workingPulseEnabled;
  }
  if (
    typeof obj.workingPulseSoundFile === "string" &&
    ALLOWED_NOTIFICATION_SOUNDS.includes(obj.workingPulseSoundFile)
  ) {
    result.workingPulseSoundFile = obj.workingPulseSoundFile;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function decodeFleetSavedScopes(raw: unknown): FleetSavedScope[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FleetSavedScope[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim()) continue;
    if (typeof o.name !== "string" || !o.name.trim()) continue;
    if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) continue;

    const lastUsedAt =
      typeof o.lastUsedAt === "number" && Number.isFinite(o.lastUsedAt) ? o.lastUsedAt : undefined;
    const usageHistory = Array.isArray(o.usageHistory)
      ? o.usageHistory.filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      : undefined;
    const usageHistoryFiltered =
      usageHistory && usageHistory.length > 0 ? usageHistory.slice(-20) : undefined;

    if (o.kind === "snapshot") {
      if (!Array.isArray(o.terminalIds)) continue;
      const terminalIds = o.terminalIds.filter((t): t is string => typeof t === "string");
      const scope: SnapshotFleetSavedScope = {
        kind: "snapshot",
        id: o.id,
        name: o.name,
        terminalIds,
        createdAt: o.createdAt,
      };
      if (lastUsedAt !== undefined) scope.lastUsedAt = lastUsedAt;
      if (usageHistoryFiltered !== undefined) scope.usageHistory = usageHistoryFiltered;
      out.push(scope);
    } else if (o.kind === "predicate") {
      if (typeof o.scope !== "string" || !VALID_PREDICATE_SCOPES.has(o.scope)) continue;
      if (typeof o.stateFilter !== "string" || !VALID_PREDICATE_STATES.has(o.stateFilter)) continue;
      const scope: PredicateFleetSavedScope = {
        kind: "predicate",
        id: o.id,
        name: o.name,
        scope: o.scope as "current" | "all",
        stateFilter: o.stateFilter as "all" | "working" | "waiting" | "finished",
        createdAt: o.createdAt,
      };
      if (lastUsedAt !== undefined) scope.lastUsedAt = lastUsedAt;
      if (usageHistoryFiltered !== undefined) scope.usageHistory = usageHistoryFiltered;
      out.push(scope);
    }
  }
  return out.length > 0 ? out : undefined;
}

function decodeCommandOverrides(raw: unknown): CommandOverride[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid: CommandOverride[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.commandId !== "string") continue;
    if (
      o.defaults !== undefined &&
      (o.defaults === null || typeof o.defaults !== "object" || Array.isArray(o.defaults))
    ) {
      continue;
    }
    if (o.disabled !== undefined && typeof o.disabled !== "boolean") continue;
    if (o.prompt !== undefined && (typeof o.prompt !== "string" || o.prompt.trim() === "")) {
      continue;
    }
    valid.push({
      commandId: o.commandId,
      defaults: o.defaults as Record<string, unknown> | undefined,
      disabled: o.disabled as boolean | undefined,
      prompt: o.prompt as string | undefined,
    });
  }
  return valid.length > 0 ? valid : undefined;
}

function decodeResourceEnvironment(raw: unknown): ResourceEnvironment | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: ResourceEnvironment = {};

  const decodeCommandArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const filtered = value.filter((s): s is string => typeof s === "string");
    return filtered.length > 0 ? filtered : undefined;
  };

  if (obj.provision !== undefined) {
    const provision = decodeCommandArray(obj.provision);
    if (provision) result.provision = provision;
    else if (!Array.isArray(obj.provision)) return undefined;
  }
  if (obj.teardown !== undefined) {
    const teardown = decodeCommandArray(obj.teardown);
    if (teardown) result.teardown = teardown;
    else if (!Array.isArray(obj.teardown)) return undefined;
  }
  if (obj.resume !== undefined) {
    const resume = decodeCommandArray(obj.resume);
    if (resume) result.resume = resume;
    else if (!Array.isArray(obj.resume)) return undefined;
  }
  if (obj.pause !== undefined) {
    const pause = decodeCommandArray(obj.pause);
    if (pause) result.pause = pause;
    else if (!Array.isArray(obj.pause)) return undefined;
  }
  if (obj.status !== undefined) {
    if (typeof obj.status !== "string") return undefined;
    result.status = obj.status;
  }
  if (obj.connect !== undefined) {
    if (typeof obj.connect !== "string") return undefined;
    result.connect = obj.connect;
  }
  if (obj.icon !== undefined) {
    if (typeof obj.icon !== "string") return undefined;
    result.icon = obj.icon;
  }

  if (Object.keys(result).length > 0) return result;
  return Object.keys(obj).length === 0 ? {} : undefined;
}

function decodeResourceEnvironments(raw: unknown): Record<string, ResourceEnvironment> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const result: Record<string, ResourceEnvironment> = {};
  for (const [name, value] of Object.entries(src)) {
    // Defend against `__proto__` keys reaching the assignment — `result[name]`
    // would otherwise invoke the `__proto__` setter and pollute the result's
    // prototype chain. JSON.parse normally hides these (sets the prototype
    // instead of an own property) but a hand-crafted or post-processed
    // settings object can surface them.
    if (name === "__proto__") continue;
    const env = decodeResourceEnvironment(value);
    if (env) result[name] = env;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function decodeMcpTier(raw: unknown): DaintreeMcpTier | undefined {
  if (typeof raw !== "string") return undefined;
  return VALID_MCP_TIERS.has(raw as DaintreeMcpTier) ? (raw as DaintreeMcpTier) : undefined;
}

function decodeBranchPrefixMode(raw: unknown): "none" | "username" | "custom" | undefined {
  if (raw === "none" || raw === "username" || raw === "custom") return raw;
  return undefined;
}

function decodeForgeProviderOverride(raw: unknown): string | null | undefined {
  if (typeof raw === "string") {
    const normalized = normalizeProviderId(raw);
    return normalized ?? undefined;
  }
  if (raw === null) return null;
  return undefined;
}

function decodePreferredEditor(raw: unknown): EditorConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string") return undefined;
  return raw as EditorConfig;
}

function decodeCopyTreeSettings(raw: unknown): CopyTreeSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: CopyTreeSettings = {};

  if (typeof obj.maxContextSize === "number" && Number.isFinite(obj.maxContextSize)) {
    result.maxContextSize = obj.maxContextSize;
  }
  if (typeof obj.maxFileSize === "number" && Number.isFinite(obj.maxFileSize)) {
    result.maxFileSize = obj.maxFileSize;
  }
  if (typeof obj.charLimit === "number" && Number.isFinite(obj.charLimit)) {
    result.charLimit = obj.charLimit;
  }
  if (obj.strategy === "all" || obj.strategy === "modified") {
    result.strategy = obj.strategy;
  }
  if (Array.isArray(obj.alwaysInclude)) {
    const filtered = obj.alwaysInclude.filter((s): s is string => typeof s === "string");
    if (filtered.length > 0) result.alwaysInclude = filtered;
  }
  if (Array.isArray(obj.alwaysExclude)) {
    const filtered = obj.alwaysExclude.filter((s): s is string => typeof s === "string");
    if (filtered.length > 0) result.alwaysExclude = filtered;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function decodeDevServerLoadTimeout(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < 1 || raw > 120) return undefined;
  return raw;
}

/**
 * Apply legacy-field migrations to produce a canonical settings shape:
 *   - `resourceEnvironment` (singular) → `resourceEnvironments` (plural)
 *   - `exposeDaintreeMcpToAgents: true` → `daintreeMcpTier: "workbench"`
 *
 * Idempotent: when the canonical fields are already present, the legacy
 * fields are ignored. Both legacy fields are kept on the returned object so
 * older readers in a mixed-version cohort don't break.
 */
function migrateLegacyFields(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...raw };

  // resourceEnvironment (singular) → resourceEnvironments (plural)
  if (
    !migrated.resourceEnvironments &&
    migrated.resourceEnvironment &&
    typeof migrated.resourceEnvironment === "object"
  ) {
    migrated.resourceEnvironments = {
      default: migrated.resourceEnvironment as ResourceEnvironment,
    };
    if (typeof migrated.activeResourceEnvironment !== "string") {
      migrated.activeResourceEnvironment = "default";
    }
  }

  // exposeDaintreeMcpToAgents → daintreeMcpTier
  if (!migrated.daintreeMcpTier && migrated.exposeDaintreeMcpToAgents === true) {
    migrated.daintreeMcpTier = "workbench";
  }

  return migrated;
}

/**
 * Decode arbitrary input into the canonical `ProjectSettings` shape.
 * Total — never throws. Future-version envelopes return `{ ok: false }`.
 */
export function decode(raw: unknown): ProjectSettingsDecodeResult {
  // Top-level guard — any non-object becomes empty defaults.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: true, settings: { runCommands: [] } };
  }

  const envelope = raw as Record<string, unknown>;

  // Future-version envelopes are rejected so callers can quarantine the file.
  // Envelopes from the current or older schema fall through; absent
  // `_schemaVersion` is treated as legacy (v0) and migrates cleanly.
  const rawVersion = envelope._schemaVersion;
  if (typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0) {
    if (rawVersion > PROJECT_SETTINGS_SCHEMA_VERSION) {
      return { ok: false, reason: "future-version", onDiskVersion: rawVersion };
    }
  }

  const migrated = migrateLegacyFields(envelope);

  const settings: ProjectSettings = {
    runCommands: Array.isArray(migrated.runCommands)
      ? (migrated.runCommands.filter(
          (c) =>
            c &&
            typeof c === "object" &&
            typeof (c as Record<string, unknown>).id === "string" &&
            typeof (c as Record<string, unknown>).command === "string"
        ) as ProjectSettings["runCommands"])
      : [],
    environmentVariables:
      migrated.environmentVariables && typeof migrated.environmentVariables === "object"
        ? (migrated.environmentVariables as Record<string, string>)
        : undefined,
    secureEnvironmentVariables: Array.isArray(migrated.secureEnvironmentVariables)
      ? migrated.secureEnvironmentVariables.filter((k): k is string => typeof k === "string")
      : undefined,
    excludedPaths: Array.isArray(migrated.excludedPaths)
      ? migrated.excludedPaths.filter((p): p is string => typeof p === "string")
      : undefined,
    projectIconSvg:
      typeof migrated.projectIconSvg === "string" ? migrated.projectIconSvg : undefined,
    defaultWorktreeRecipeId:
      typeof migrated.defaultWorktreeRecipeId === "string"
        ? migrated.defaultWorktreeRecipeId
        : undefined,
    devServerCommand:
      typeof migrated.devServerCommand === "string" ? migrated.devServerCommand : undefined,
    devServerDismissed:
      typeof migrated.devServerDismissed === "boolean" ? migrated.devServerDismissed : undefined,
    devServerAutoDetected:
      typeof migrated.devServerAutoDetected === "boolean"
        ? migrated.devServerAutoDetected
        : undefined,
    cloudSyncWarningDismissed:
      typeof migrated.cloudSyncWarningDismissed === "boolean"
        ? migrated.cloudSyncWarningDismissed
        : undefined,
    devServerLoadTimeout: decodeDevServerLoadTimeout(migrated.devServerLoadTimeout),
    turbopackEnabled:
      typeof migrated.turbopackEnabled === "boolean" ? migrated.turbopackEnabled : undefined,
    copyTreeSettings: decodeCopyTreeSettings(migrated.copyTreeSettings),
    commandOverrides: decodeCommandOverrides(migrated.commandOverrides),
    preferredEditor: decodePreferredEditor(migrated.preferredEditor),
    branchPrefixMode: decodeBranchPrefixMode(migrated.branchPrefixMode),
    branchPrefixCustom:
      typeof migrated.branchPrefixCustom === "string" ? migrated.branchPrefixCustom : undefined,
    // Migration: the canonical `forgeRemote` wins, but a blank/whitespace
    // value falls through to the legacy `githubRemote` so an empty string
    // can't strand existing projects mid-migration (#8456).
    forgeRemote: (() => {
      const canonical =
        typeof migrated.forgeRemote === "string" && migrated.forgeRemote.trim().length > 0
          ? migrated.forgeRemote.trim()
          : undefined;
      if (canonical) return canonical;
      return typeof migrated.githubRemote === "string" && migrated.githubRemote.trim().length > 0
        ? migrated.githubRemote.trim()
        : undefined;
    })(),
    forgeProviderOverride: decodeForgeProviderOverride(migrated.forgeProviderOverride),
    worktreePathPattern:
      typeof migrated.worktreePathPattern === "string" && migrated.worktreePathPattern.trim()
        ? migrated.worktreePathPattern.trim()
        : undefined,
    terminalSettings: decodeTerminalSettings(migrated.terminalSettings),
    notificationOverrides: decodeNotificationOverrides(migrated.notificationOverrides),
    fleetSavedScopes: decodeFleetSavedScopes(migrated.fleetSavedScopes),
    resourceEnvironments: decodeResourceEnvironments(migrated.resourceEnvironments),
    activeResourceEnvironment:
      typeof migrated.activeResourceEnvironment === "string"
        ? migrated.activeResourceEnvironment
        : undefined,
    defaultWorktreeMode:
      typeof migrated.defaultWorktreeMode === "string" ? migrated.defaultWorktreeMode : undefined,
    daintreeMcpTier: decodeMcpTier(migrated.daintreeMcpTier),
    exposeDaintreeMcpToAgents:
      typeof migrated.exposeDaintreeMcpToAgents === "boolean"
        ? migrated.exposeDaintreeMcpToAgents
        : undefined,
    browserAllowedHosts: Array.isArray(migrated.browserAllowedHosts)
      ? migrated.browserAllowedHosts.filter((h): h is string => typeof h === "string")
      : undefined,
    preferredImageViewer:
      migrated.preferredImageViewer && typeof migrated.preferredImageViewer === "object"
        ? (migrated.preferredImageViewer as ProjectSettings["preferredImageViewer"])
        : undefined,
    gitInitDefaults:
      migrated.gitInitDefaults && typeof migrated.gitInitDefaults === "object"
        ? (migrated.gitInitDefaults as ProjectSettings["gitInitDefaults"])
        : undefined,
  };

  return { ok: true, settings };
}

/**
 * Serialize a canonical `ProjectSettings` to the on-disk envelope.
 * Transient fields (`insecureEnvironmentVariables`,
 * `unresolvedSecureEnvironmentVariables`, `agentInstructions`) are stripped
 * — those are runtime helpers, not persisted state. The legacy
 * `resourceEnvironment`, `exposeDaintreeMcpToAgents`, and `githubRemote`
 * fields are also stripped since they have already been migrated into their
 * canonical counterparts at decode time.
 */
export function encodeEnvelope(settings: ProjectSettings): Record<string, unknown> {
  // Strip transient runtime fields, both legacy migration fields, the
  // optional `agentInstructions` runtime helper, and any caller-supplied
  // `_schemaVersion` (which would otherwise survive `.passthrough()` from
  // the IPC save schema and overwrite the codec's authoritative version).
  // The destructure mirrors the security boundary: this is the last code
  // path before bytes hit disk.
  const persistable = { ...settings } as Record<string, unknown>;
  delete persistable.insecureEnvironmentVariables;
  delete persistable.unresolvedSecureEnvironmentVariables;
  delete persistable.resourceEnvironment;
  delete persistable.exposeDaintreeMcpToAgents;
  delete persistable.githubRemote;
  delete persistable.agentInstructions;
  // Removed exit-snapshot feature (#10850/#10855): drop any stale opt-out flag a
  // passthrough save payload might still carry so it never re-lands on disk.
  delete persistable.exitSnapshotExcluded;
  delete persistable._schemaVersion;

  return {
    _schemaVersion: PROJECT_SETTINGS_SCHEMA_VERSION,
    ...persistable,
  };
}

/**
 * Zod schema that gates the `project:save-settings` IPC channel. Uses
 * `.passthrough()` so forward-compat fields aren't dropped at the boundary
 * and the renderer can keep including new fields ahead of a backend update.
 *
 * Notably permits both `daintreeMcpTier` and the deprecated
 * `exposeDaintreeMcpToAgents` — the agent-action wrapper at
 * `src/services/actions/definitions/projectActions.ts` strips both before
 * the IPC call, and the renderer settings dialog still passes them through
 * legitimately.
 */
export const ProjectSettingsSaveSchema = z
  .object({
    runCommands: z.array(z.unknown()).optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    secureEnvironmentVariables: z.array(z.string()).optional(),
    insecureEnvironmentVariables: z.array(z.string()).optional(),
    unresolvedSecureEnvironmentVariables: z.array(z.string()).optional(),
    excludedPaths: z.array(z.string()).optional(),
    projectIconSvg: z.string().optional(),
    defaultWorktreeRecipeId: z.string().optional(),
    devServerCommand: z.string().optional(),
    devServerDismissed: z.boolean().optional(),
    devServerAutoDetected: z.boolean().optional(),
    cloudSyncWarningDismissed: z.boolean().optional(),
    devServerLoadTimeout: z.number().optional(),
    turbopackEnabled: z.boolean().optional(),
    copyTreeSettings: z.unknown().optional(),
    commandOverrides: z.array(z.unknown()).optional(),
    gitInitDefaults: z.unknown().optional(),
    preferredEditor: z.unknown().optional(),
    preferredImageViewer: z.unknown().optional(),
    branchPrefixMode: z.enum(["none", "username", "custom"]).optional(),
    branchPrefixCustom: z.string().optional(),
    forgeRemote: z.string().optional(),
    githubRemote: z.string().optional(),
    forgeProviderOverride: z.union([z.string(), z.null()]).optional(),
    worktreePathPattern: z.string().optional(),
    fleetSavedScopes: z.array(z.unknown()).optional(),
    terminalSettings: z.unknown().optional(),
    notificationOverrides: z.unknown().optional(),
    resourceEnvironment: z.unknown().optional(),
    resourceEnvironments: z.record(z.string(), z.unknown()).optional(),
    activeResourceEnvironment: z.string().optional(),
    defaultWorktreeMode: z.string().optional(),
    daintreeMcpTier: z.enum(["off", "workbench", "action", "system"]).optional(),
    exposeDaintreeMcpToAgents: z.boolean().optional(),
    browserAllowedHosts: z.array(z.string()).optional(),
    agentInstructions: z.unknown().optional(),
  })
  .passthrough()
  // Defense-in-depth: even though `encodeEnvelope` strips `_schemaVersion`
  // before write, reject any caller-supplied envelope key at the IPC
  // boundary so a renderer can't spoof versions or trigger quarantine.
  .refine((value) => !Object.prototype.hasOwnProperty.call(value, "_schemaVersion"), {
    message: "_schemaVersion is reserved",
  });

/** Internal helpers exported only for unit tests. */
export const __internal = {
  decodeTerminalSettings,
  decodeNotificationOverrides,
  decodeFleetSavedScopes,
  decodeCopyTreeSettings,
  decodeResourceEnvironments,
  migrateLegacyFields,
};
