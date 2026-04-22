import type { PanelKind, TerminalType, AgentState } from "@/types";
import type { BrowserHistory } from "@shared/types/browser";
import type { PanelExitBehavior } from "@shared/types/panel";
import type { AddPanelOptionsBase } from "@shared/types/addPanelOptions";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import {
  isRegisteredAgent,
  getAgentConfig,
  getMergedPreset,
  sanitizeAgentEnv,
} from "@/config/agents";
import {
  generateAgentCommand,
  buildResumeCommand,
  buildLaunchCommandFromFlags,
} from "@shared/types";
import { logWarn } from "@/utils/logger";
import { inferKind as inferKindShared } from "@shared/utils/inferPanelKind";
import { getDeserializer } from "@/config/panelKindSerialisers";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";

/**
 * Args for building addPanel options from hydration data.
 * Uses AddPanelOptionsBase (flat) rather than the discriminated union because
 * hydration builders construct args dynamically based on saved state,
 * mixing fields from different panel kinds.
 */
export interface AddTerminalArgs extends AddPanelOptionsBase {
  cwd: string;
  location?: "grid" | "dock";
  browserUrl?: string;
  browserHistory?: BrowserHistory;
  browserZoom?: number;
  browserConsoleOpen?: boolean;
  createdAt?: number;
  devCommand?: string;
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  devServerUrl?: string | null;
  devServerError?: { type: string; message: string } | null;
  devServerTerminalId?: string | null;
  devPreviewConsoleOpen?: boolean;
  viewportPreset?: string;
}

export interface SavedTerminalData {
  id: string;
  kind?: PanelKind;
  type?: TerminalType;
  agentId?: string;
  title?: string;
  cwd?: string;
  worktreeId?: string;
  location?: string;
  command?: string;
  isInputLocked?: boolean;
  browserUrl?: string;
  browserHistory?: BrowserHistory;
  browserZoom?: number;
  browserConsoleOpen?: boolean;
  createdAt?: number;
  devCommand?: string;
  devPreviewConsoleOpen?: boolean;
  viewportPreset?: string;
  exitBehavior?: PanelExitBehavior;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  agentPresetId?: string;
  agentPresetColor?: string;
  /** @deprecated pre-#5459 legacy key; read-only fallback, never written. */
  agentFlavorId?: string;
  /** @deprecated pre-#5459 legacy key; read-only fallback, never written. */
  agentFlavorColor?: string;
  extensionState?: Record<string, unknown>;
  pluginId?: string;
}

function readPresetId(saved: SavedTerminalData): string | undefined {
  return saved.agentPresetId ?? saved.agentFlavorId;
}

function readPresetColor(saved: SavedTerminalData): string | undefined {
  return saved.agentPresetColor ?? saved.agentFlavorColor;
}

interface BackendTerminalData {
  id: string;
  kind?: PanelKind;
  type?: TerminalType;
  agentId?: string;
  title?: string;
  cwd: string;
  agentState?: AgentState;
  lastStateChange?: number;
  activityTier?: "active" | "background";
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  everDetectedAgent?: boolean;
  detectedAgentId?: BuiltInAgentId;
}

interface ReconnectedTerminalData {
  id?: string;
  kind?: PanelKind;
  type?: TerminalType;
  agentId?: string;
  title?: string;
  cwd?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  activityTier?: "active" | "background";
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  everDetectedAgent?: boolean;
  detectedAgentId?: BuiltInAgentId;
}

interface AgentSettingsData {
  agents?: Record<string, Record<string, unknown>>;
}

export function inferAgentIdFromTitle(
  title: string | undefined,
  kind: PanelKind | undefined,
  existingAgentId: string | undefined,
  terminalId: string,
  logContext: string
): string | undefined {
  if (existingAgentId) return existingAgentId;
  if (kind !== "agent") return undefined;

  const titleLower = (title ?? "").toLowerCase();
  if (titleLower.includes("claude")) return "claude";
  if (titleLower.includes("gemini")) return "gemini";
  if (titleLower.includes("codex")) return "codex";
  if (titleLower.includes("opencode")) return "opencode";

  logWarn(
    `${logContext} agent terminal ${terminalId} missing agentId and title doesn't match known agents: "${title ?? ""}"`
  );
  return undefined;
}

export function resolveAgentId(
  primaryAgentId: string | undefined,
  primaryType: TerminalType | undefined,
  fallbackAgentId?: string | undefined,
  fallbackType?: TerminalType | undefined
): string | undefined {
  if (primaryAgentId) return primaryAgentId;
  if (primaryType && isRegisteredAgent(primaryType)) return primaryType;
  if (fallbackAgentId) return fallbackAgentId;
  if (fallbackType && isRegisteredAgent(fallbackType)) return fallbackType;
  return undefined;
}

export const inferKind: (saved: SavedTerminalData) => PanelKind = inferKindShared;

export function buildArgsForBackendTerminal(
  backendTerminal: BackendTerminalData,
  saved: SavedTerminalData,
  projectRoot: string
): AddTerminalArgs {
  const cwd = backendTerminal.cwd || projectRoot || "";
  let agentId = resolveAgentId(backendTerminal.agentId, backendTerminal.type);
  agentId = inferAgentIdFromTitle(
    backendTerminal.title,
    backendTerminal.kind,
    agentId,
    backendTerminal.id,
    "Backend"
  );

  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";
  const isDevPreview = backendTerminal.kind === "dev-preview";
  const devCommand = isDevPreview ? saved.command?.trim() : undefined;

  return {
    kind: backendTerminal.kind ?? (agentId ? "agent" : "terminal"),
    type: backendTerminal.type,
    agentId,
    title: saved.title ?? backendTerminal.title,
    cwd,
    worktreeId: saved.worktreeId,
    location,
    existingId: backendTerminal.id,
    agentState: backendTerminal.agentState,
    lastStateChange: backendTerminal.lastStateChange,
    devCommand,
    browserUrl: isDevPreview ? saved.browserUrl : undefined,
    browserHistory: isDevPreview ? saved.browserHistory : undefined,
    browserZoom: isDevPreview ? saved.browserZoom : undefined,
    devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
    exitBehavior: saved.exitBehavior,
    agentSessionId: backendTerminal.agentSessionId ?? saved.agentSessionId,
    agentLaunchFlags: backendTerminal.agentLaunchFlags ?? saved.agentLaunchFlags,
    agentModelId: backendTerminal.agentModelId ?? saved.agentModelId,
    everDetectedAgent: backendTerminal.everDetectedAgent,
    detectedAgentId: backendTerminal.detectedAgentId,
    agentPresetId: readPresetId(saved),
    agentPresetColor: readPresetColor(saved),
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
  };
}

export function buildArgsForReconnectedFallback(
  reconnectedTerminal: ReconnectedTerminalData,
  saved: SavedTerminalData,
  projectRoot: string
): AddTerminalArgs {
  const cwd = reconnectedTerminal.cwd || saved.cwd || projectRoot || "";
  let agentId = resolveAgentId(
    reconnectedTerminal.agentId,
    reconnectedTerminal.type,
    saved.agentId,
    saved.type
  );

  const reconnectedKind = reconnectedTerminal.kind ?? saved.kind;
  agentId = inferAgentIdFromTitle(
    reconnectedTerminal.title ?? saved.title,
    reconnectedKind,
    agentId,
    saved.id,
    "Reconnected"
  );

  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";
  const isDevPreview = reconnectedKind === "dev-preview";
  const devCommand = isDevPreview ? saved.command?.trim() : undefined;

  return {
    kind: reconnectedKind ?? (agentId ? "agent" : "terminal"),
    type: reconnectedTerminal.type ?? saved.type,
    agentId,
    title: saved.title ?? reconnectedTerminal.title,
    cwd,
    worktreeId: saved.worktreeId,
    location,
    existingId: reconnectedTerminal.id,
    agentState: reconnectedTerminal.agentState,
    lastStateChange: reconnectedTerminal.lastStateChange,
    devCommand,
    browserUrl: isDevPreview ? saved.browserUrl : undefined,
    browserHistory: isDevPreview ? saved.browserHistory : undefined,
    browserZoom: isDevPreview ? saved.browserZoom : undefined,
    devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
    exitBehavior: saved.exitBehavior,
    agentSessionId: reconnectedTerminal.agentSessionId ?? saved.agentSessionId,
    agentLaunchFlags: reconnectedTerminal.agentLaunchFlags ?? saved.agentLaunchFlags,
    agentModelId: reconnectedTerminal.agentModelId ?? saved.agentModelId,
    everDetectedAgent: reconnectedTerminal.everDetectedAgent,
    detectedAgentId: reconnectedTerminal.detectedAgentId,
    agentPresetId: readPresetId(saved),
    agentPresetColor: readPresetColor(saved),
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
  };
}

export function buildArgsForRespawn(
  saved: SavedTerminalData,
  kind: PanelKind,
  projectRoot: string,
  agentSettings: AgentSettingsData | undefined,
  reconnectTimedOut: boolean,
  clipboardDirectory: string | undefined
): AddTerminalArgs {
  let effectiveAgentId = resolveAgentId(saved.agentId, saved.type);
  effectiveAgentId = inferAgentIdFromTitle(
    saved.title,
    kind,
    effectiveAgentId,
    saved.id,
    "Respawn"
  );

  const isAgentPanel = kind === "agent" || Boolean(effectiveAgentId);
  const agentId = effectiveAgentId;
  let command = saved.command?.trim() || undefined;
  let presetEnv: Record<string, string> | undefined;
  let preset: ReturnType<typeof getMergedPreset> | undefined;

  if (agentId) {
    const agentConfig = getAgentConfig(agentId);
    const baseCommand = agentConfig?.command || agentId;
    const persistedFlags = saved.agentLaunchFlags;
    const hasPersistedFlags = Boolean(persistedFlags && persistedFlags.length > 0);
    const baseEntry = agentSettings?.agents?.[agentId] ?? {};
    const shareClipboardDirectory = baseEntry.shareClipboardDirectory as boolean | undefined;
    const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[agentId];
    const savedPresetId = readPresetId(saved);
    preset = savedPresetId
      ? getMergedPreset(agentId, savedPresetId, baseEntry.customPresets as never, ccrPresets)
      : undefined;
    const effectiveEntry = preset
      ? {
          ...baseEntry,
          ...(preset.dangerousEnabled !== undefined && {
            dangerousEnabled: preset.dangerousEnabled,
          }),
          ...(preset.customFlags !== undefined && { customFlags: preset.customFlags }),
          ...(preset.inlineMode !== undefined && { inlineMode: preset.inlineMode }),
        }
      : baseEntry;
    // Merge: global env (base) overridden by preset env (preset wins on conflicts)
    const sanitizedGlobal = sanitizeAgentEnv(
      (baseEntry.globalEnv ?? {}) as Record<string, unknown>
    );
    const sanitizedPreset = preset?.env;
    if (sanitizedGlobal || sanitizedPreset) {
      presetEnv = { ...sanitizedGlobal, ...sanitizedPreset };
    }

    const buildFromPersistedFlags = () =>
      buildLaunchCommandFromFlags(baseCommand, agentId, persistedFlags as string[], {
        clipboardDirectory,
        shareClipboardDirectory,
      });

    if (saved.agentSessionId) {
      const resumeCmd = buildResumeCommand(agentId, saved.agentSessionId, persistedFlags);
      if (resumeCmd) {
        command = resumeCmd;
      } else if (hasPersistedFlags) {
        command = buildFromPersistedFlags();
      } else if (agentSettings) {
        command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
          clipboardDirectory,
          modelId: saved.agentModelId,
          presetArgs: preset?.args?.join(" "),
        });
      }
    } else if (hasPersistedFlags) {
      command = buildFromPersistedFlags();
    } else if (agentSettings) {
      command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
        clipboardDirectory,
        modelId: saved.agentModelId,
        presetArgs: preset?.args?.join(" "),
      });
    }
  }

  const respawnKind = isAgentPanel ? "agent" : kind;
  const isDevPreview = kind === "dev-preview";
  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

  // Stale-preset split-brain: when saved.agentPresetId was set but the preset
  // no longer resolves (deleted custom preset, CCR route removed from config),
  // clear agentPresetId/agentPresetColor and strip the preset suffix from the
  // title so the respawned panel doesn't lie about its identity — it's now
  // running default env/command, so it should look like default.
  const savedPresetIdForRespawn = readPresetId(saved);
  const savedPresetColorForRespawn = readPresetColor(saved);
  const presetWasStale = isAgentPanel && !!savedPresetIdForRespawn && !preset;
  const respawnAgentPresetId = presetWasStale ? undefined : savedPresetIdForRespawn;
  const respawnAgentPresetColor = presetWasStale
    ? undefined
    : (preset?.color ?? savedPresetColorForRespawn);
  const respawnTitle = presetWasStale
    ? (agentId ? getAgentConfig(agentId)?.name : saved.title) || saved.title
    : saved.title;

  return {
    kind: respawnKind,
    type: saved.type,
    agentId,
    title: respawnTitle,
    cwd: saved.cwd || projectRoot || "",
    worktreeId: saved.worktreeId,
    location,
    requestedId: reconnectTimedOut ? undefined : saved.id,
    command: isAgentPanel ? command : saved.command?.trim() || undefined,
    isInputLocked: saved.isInputLocked,
    devCommand: isDevPreview ? command : undefined,
    browserUrl: isDevPreview ? saved.browserUrl : undefined,
    browserHistory: isDevPreview ? saved.browserHistory : undefined,
    browserZoom: isDevPreview ? saved.browserZoom : undefined,
    devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
    exitBehavior: isAgentPanel ? undefined : saved.exitBehavior,
    agentLaunchFlags: saved.agentLaunchFlags,
    agentModelId: saved.agentModelId,
    agentPresetId: respawnAgentPresetId,
    agentPresetColor: respawnAgentPresetColor,
    env: presetEnv,
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
    restore: true,
  };
}

export function buildArgsForNonPtyRecreation(
  saved: SavedTerminalData,
  kind: PanelKind,
  projectRoot: string
): AddTerminalArgs {
  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";
  const base: AddTerminalArgs = {
    kind,
    title: saved.title,
    cwd: saved.cwd || projectRoot || "",
    worktreeId: saved.worktreeId,
    location,
    requestedId: saved.id,
    exitBehavior: saved.exitBehavior,
    agentPresetId: readPresetId(saved),
    agentPresetColor: readPresetColor(saved),
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
  };

  const deserializer = getDeserializer(kind);
  if (deserializer) {
    return { ...base, ...deserializer(saved) };
  }

  return base;
}

/**
 * Infer a worktreeId from a terminal's cwd by longest-prefix matching against the
 * worktrees list. Returns undefined when no worktree's path is a prefix of cwd.
 * Uses segment-aware matching (both POSIX and Windows separators) to avoid false
 * positives where `/repo/wt` would match `/repo/wt-long`.
 */
export function inferWorktreeIdFromCwd(
  cwd: string | undefined,
  worktrees: ReadonlyArray<{ id: string; path: string }> | undefined
): string | undefined {
  if (!cwd || !worktrees || worktrees.length === 0) return undefined;
  let best: { id: string; path: string } | undefined;
  for (const wt of worktrees) {
    if (!wt.path) continue;
    if (cwd === wt.path || cwd.startsWith(wt.path + "/") || cwd.startsWith(wt.path + "\\")) {
      if (!best || wt.path.length > best.path.length) {
        best = wt;
      }
    }
  }
  return best?.id;
}

export function buildArgsForOrphanedTerminal(
  terminal: BackendTerminalData,
  projectRoot: string
): AddTerminalArgs {
  const cwd = terminal.cwd || projectRoot || "";
  let agentId = resolveAgentId(terminal.agentId, terminal.type);
  agentId = inferAgentIdFromTitle(terminal.title, terminal.kind, agentId, terminal.id, "Orphaned");

  return {
    kind: terminal.kind ?? (agentId ? "agent" : "terminal"),
    type: terminal.type,
    agentId,
    title: terminal.title,
    cwd,
    location: "grid",
    existingId: terminal.id,
    agentState: terminal.agentState,
    lastStateChange: terminal.lastStateChange,
    agentSessionId: terminal.agentSessionId,
    agentLaunchFlags: terminal.agentLaunchFlags,
    agentModelId: terminal.agentModelId,
    everDetectedAgent: terminal.everDetectedAgent,
    detectedAgentId: terminal.detectedAgentId,
  };
}
