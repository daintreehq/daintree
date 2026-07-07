import type { PanelKind, AgentState } from "@/types";
import { coerceAgentState, coerceWaitingReason, type WaitingReason } from "@shared/types/agent";
import type { BrowserHistory } from "@shared/types/browser";
import type { MarkdownViewMode, PanelExitBehavior, PanelTitleMode } from "@shared/types/panel";
import type { AddPanelOptionsBase } from "@shared/types/addPanelOptions";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { getAgentConfig, sanitizeAgentEnv } from "@/config/agents";
import type { AgentPreset } from "@/config/agents";
import {
  generateAgentCommand,
  buildResumeCommand,
  buildResumeLatestCommand,
  buildLaunchCommandFromFlags,
  reconcileBypassFlags,
  reconcileInlineModeFlag,
  resolveEffectiveBypass,
  resolveEffectiveInlineMode,
} from "@shared/types";
import { inferKind as inferKindShared } from "@shared/utils/inferPanelKind";
import { isAbsolute } from "@shared/utils/path";
import { getDeserializer } from "@/config/panelKindSerialisers";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { resolveAgentRuntimeSettings } from "@/utils/agentRuntimeSettings";

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
  devPreviewConsoleTab?: "output" | "console" | "diagnostics";
  viewportPreset?: string;
  viewportRotated?: boolean;
  viewportDpr?: 1 | 2 | 3;
  viewportFit?: boolean;
  devPreviewScrollPosition?: { url: string; scrollY: number };
  markdownFilePath?: string;
  markdownViewMode?: MarkdownViewMode;
  /**
   * Preserved user-initiated focus timestamp from the saved snapshot. The
   * post-hydration focus picker in `useAppHydration` reads this off
   * `panelsById[id]` to pick the active worktree's most-recently-focused
   * panel, so the data must survive the save→restore round-trip
   * (#9933). Conditional on being a valid finite > 0 value; never
   * defaults to `Date.now()` here — the restore path must reflect the
   * user's last actual focus, not the current boot time.
   */
  lastActiveAt?: number;
}

export interface SavedTerminalData {
  id: string;
  kind?: PanelKind;
  /** Legacy persisted discriminator — read-only migration field, never written. */
  type?: string;
  /** Legacy persisted agent hint — superseded by launchAgentId. Read at hydration boundary only. */
  agentId?: string;
  launchAgentId?: string;
  title?: string;
  /** Title ownership rung persisted with the snapshot — restoring it is what keeps preset/user titles pinned across restart (#10738). */
  titleMode?: PanelTitleMode;
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
  devPreviewConsoleTab?: "output" | "console" | "diagnostics";
  viewportPreset?: string;
  viewportRotated?: boolean;
  viewportDpr?: 1 | 2 | 3;
  viewportFit?: boolean;
  devPreviewScrollPosition?: { url: string; scrollY: number };
  markdownFilePath?: string;
  /** Untrusted on-disk string — sanitized to MarkdownViewMode at the deserializer boundary. */
  markdownViewMode?: string;
  exitBehavior?: PanelExitBehavior;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  agentPresetId?: string;
  agentPresetColor?: string;
  originalPresetId?: string;
  /**
   * Caller-resolved launch env captured at launch time (#10922). Preferred over
   * live preset re-resolution on respawn so a restored session replays the same
   * provider environment it launched with. Typed as `unknown`-valued because it
   * is untrusted on-disk JSON — sanitized via `sanitizeAgentEnv` at the read
   * boundary before use.
   */
  env?: Record<string, unknown>;
  isUsingFallback?: boolean;
  fallbackChainIndex?: number;
  /** @deprecated pre-#5459 legacy key; read-only fallback, never written. */
  agentFlavorId?: string;
  /** @deprecated pre-#5459 legacy key; read-only fallback, never written. */
  agentFlavorColor?: string;
  extensionState?: Record<string, unknown>;
  pluginId?: string;
  /**
   * User-initiated focus timestamp from the saved snapshot. Read at the
   * hydration boundary and propagated to the live panel via the
   * `AddTerminalArgs.lastActiveAt` field (#9933), so the post-hydration
   * focus picker in `useAppHydration` can pick the active worktree's
   * most-recently-focused panel. Without this field, the picker falls
   * back to first-in-`panelIds`-order and silently regresses to the
   * pre-#9933 behavior the issue was meant to fix.
   */
  lastActiveAt?: number;
}

function readPresetId(saved: SavedTerminalData): string | undefined {
  return saved.agentPresetId ?? saved.agentFlavorId;
}

function readPresetColor(saved: SavedTerminalData): string | undefined {
  return saved.agentPresetColor ?? saved.agentFlavorColor;
}

// Backend snapshots carry the waiting reason so re-created views keep their
// attention indicators (approval/question/error) across LRU eviction and
// reconnect. Gated on the coerced state so a stale reason never survives a
// non-waiting restore.
function restoredWaitingReason(t: {
  agentState?: AgentState;
  waitingReason?: WaitingReason;
}): WaitingReason | undefined {
  return coerceAgentState(t.agentState) === "waiting"
    ? coerceWaitingReason(t.waitingReason)
    : undefined;
}

interface BackendTerminalData {
  id: string;
  kind?: PanelKind;
  launchAgentId?: string;
  title?: string;
  titleMode?: PanelTitleMode;
  cwd: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  activityTier?: "active" | "background";
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  agentPresetId?: string;
  agentPresetColor?: string;
  originalAgentPresetId?: string;
  everDetectedAgent?: boolean;
  detectedAgentId?: BuiltInAgentId;
  detectedProcessId?: string;
}

interface ReconnectedTerminalData {
  id?: string;
  kind?: PanelKind;
  launchAgentId?: string;
  title?: string;
  titleMode?: PanelTitleMode;
  cwd?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  activityTier?: "active" | "background";
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  agentPresetId?: string;
  agentPresetColor?: string;
  originalAgentPresetId?: string;
  everDetectedAgent?: boolean;
  detectedAgentId?: BuiltInAgentId;
  detectedProcessId?: string;
}

interface AgentSettingsData {
  agents?: Record<string, Record<string, unknown>>;
  globalSkipPermissions?: boolean;
  globalUseAltScreen?: boolean;
}

export function inferAgentIdFromTitle(
  title: string | undefined,
  kind: PanelKind | undefined,
  existingAgentId: string | undefined,
  _terminalId: string,
  _logContext: string
): string | undefined {
  if (existingAgentId) return existingAgentId;
  // Only recover agent identity from persisted state that was *itself* written
  // as an agent panel — the legacy `kind: "agent"` marker. Plain terminals with
  // incidental "claude" or "gemini" in their user-assigned title must not be
  // silently promoted to agent terminals during respawn (that would regenerate
  // a Claude launch command and take over the user's renamed shell).
  if (kind !== "agent") return undefined;

  const titleLower = (title ?? "").toLowerCase();
  if (titleLower.includes("claude")) return "claude";
  if (titleLower.includes("antigravity")) return "antigravity";
  if (titleLower.includes("gemini")) return "gemini";
  if (titleLower.includes("codex")) return "codex";
  if (titleLower.includes("opencode")) return "opencode";

  return undefined;
}

export function resolveAgentId(
  primaryAgentId: string | undefined,
  fallbackAgentId?: string | undefined
): string | undefined {
  if (primaryAgentId) return primaryAgentId;
  if (fallbackAgentId) return fallbackAgentId;
  return undefined;
}

export const inferKind: (saved: SavedTerminalData) => PanelKind = inferKindShared;

function resolveSavedCwd(savedCwd: string | undefined, projectRoot: string): string {
  if (savedCwd && isAbsolute(savedCwd)) return savedCwd;
  return projectRoot || "";
}

/**
 * Normalize a kind value for hydration builders. Legacy `"agent"` values
 * (from persisted state written before the kind collapse) migrate to
 * `"terminal"`. Missing/unknown values fall through to `"terminal"`, matching
 * the previous fallback behavior for PTY panels.
 */
function normalizePtyKind(kind: PanelKind | undefined): PanelKind {
  if (!kind || kind === "agent") return "terminal";
  return kind;
}

/**
 * Validate a `lastActiveAt` timestamp from a saved snapshot before
 * propagating it to the live panel via `AddTerminalArgs.lastActiveAt`
 * (#9933). Mirrors the rejection rule in `panelRestorePhase.ts:109`:
 * `Number.isFinite && > 0`. Returns `undefined` for any other value
 * (NaN, ±Infinity, <= 0, missing) so a corrupted persisted value can't
 * silently seed the post-hydration focus picker with a sentinel that
 * would always win (e.g. `Number.MAX_SAFE_INTEGER` from a buggy writer).
 */
function sanitizeLastActiveAt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function buildArgsForBackendTerminal(
  backendTerminal: BackendTerminalData,
  saved: SavedTerminalData,
  projectRoot: string
): AddTerminalArgs {
  const cwd = backendTerminal.cwd || projectRoot || "";
  // Fall back to saved.launchAgentId when the backend record lost it (e.g. PTY-host
  // restart before persistence flushed) — mirrors buildArgsForReconnectedFallback.
  // Also fall back to legacy saved.agentId for on-disk state written before this migration.
  const savedLaunchAgentId =
    saved.launchAgentId ?? (saved.type === "claude" ? "claude" : saved.agentId);
  let launchAgentId = resolveAgentId(backendTerminal.launchAgentId, savedLaunchAgentId);
  launchAgentId = inferAgentIdFromTitle(
    backendTerminal.title,
    backendTerminal.kind,
    launchAgentId,
    backendTerminal.id,
    "Backend"
  );

  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";
  const isDevPreview = backendTerminal.kind === "dev-preview";
  const devCommand = isDevPreview ? saved.command?.trim() : undefined;

  return {
    kind: normalizePtyKind(backendTerminal.kind),
    launchAgentId,
    title: saved.title ?? backendTerminal.title,
    titleMode: saved.titleMode ?? backendTerminal.titleMode,
    cwd,
    worktreeId: saved.worktreeId,
    location,
    existingId: backendTerminal.id,
    agentState: coerceAgentState(backendTerminal.agentState),
    waitingReason: restoredWaitingReason(backendTerminal),
    lastStateChange: backendTerminal.lastStateChange,
    devCommand,
    browserUrl: isDevPreview ? saved.browserUrl : undefined,
    browserHistory: isDevPreview ? saved.browserHistory : undefined,
    browserZoom: isDevPreview ? saved.browserZoom : undefined,
    devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
    devPreviewConsoleTab:
      isDevPreview &&
      (saved.devPreviewConsoleTab === "console" ||
        saved.devPreviewConsoleTab === "output" ||
        saved.devPreviewConsoleTab === "diagnostics")
        ? saved.devPreviewConsoleTab
        : undefined,
    devPreviewScrollPosition: isDevPreview ? saved.devPreviewScrollPosition : undefined,
    exitBehavior: saved.exitBehavior,
    agentSessionId: backendTerminal.agentSessionId ?? saved.agentSessionId,
    agentLaunchFlags: backendTerminal.agentLaunchFlags ?? saved.agentLaunchFlags,
    agentModelId: backendTerminal.agentModelId ?? saved.agentModelId,
    everDetectedAgent: backendTerminal.everDetectedAgent,
    detectedAgentId: backendTerminal.detectedAgentId,
    detectedProcessId: backendTerminal.detectedProcessId,
    agentPresetId: readPresetId(saved) ?? backendTerminal.agentPresetId,
    agentPresetColor: readPresetColor(saved) ?? backendTerminal.agentPresetColor,
    originalPresetId:
      saved.originalPresetId ??
      backendTerminal.originalAgentPresetId ??
      readPresetId(saved) ??
      backendTerminal.agentPresetId,
    // Carry the captured launch env forward so a reconnect (project switch /
    // renderer reload to a still-live PTY) re-serializes the snapshot WITH env,
    // instead of dropping it and reintroducing the provider swap on the next
    // full restart (#10922). Not used to spawn here — the PTY already has it.
    env: sanitizeAgentEnv(saved.env),
    isUsingFallback: saved.isUsingFallback,
    fallbackChainIndex: saved.fallbackChainIndex,
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
    lastActiveAt: sanitizeLastActiveAt(saved.lastActiveAt),
  };
}

export function buildArgsForReconnectedFallback(
  reconnectedTerminal: ReconnectedTerminalData,
  saved: SavedTerminalData,
  projectRoot: string
): AddTerminalArgs {
  const cwd = reconnectedTerminal.cwd || saved.cwd || projectRoot || "";
  // Migrate legacy on-disk agentId/type to launchAgentId at the read boundary.
  const savedLaunchAgentId =
    saved.launchAgentId ?? (saved.type === "claude" ? "claude" : saved.agentId);
  let launchAgentId = resolveAgentId(reconnectedTerminal.launchAgentId, savedLaunchAgentId);

  const reconnectedKind = reconnectedTerminal.kind ?? saved.kind;
  launchAgentId = inferAgentIdFromTitle(
    reconnectedTerminal.title ?? saved.title,
    reconnectedKind,
    launchAgentId,
    saved.id,
    "Reconnected"
  );

  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";
  const isDevPreview = reconnectedKind === "dev-preview";
  const devCommand = isDevPreview ? saved.command?.trim() : undefined;

  return {
    kind: normalizePtyKind(reconnectedKind),
    launchAgentId,
    title: saved.title ?? reconnectedTerminal.title,
    titleMode: saved.titleMode ?? reconnectedTerminal.titleMode,
    cwd,
    worktreeId: saved.worktreeId,
    location,
    existingId: reconnectedTerminal.id,
    agentState: coerceAgentState(reconnectedTerminal.agentState),
    waitingReason: restoredWaitingReason(reconnectedTerminal),
    lastStateChange: reconnectedTerminal.lastStateChange,
    devCommand,
    browserUrl: isDevPreview ? saved.browserUrl : undefined,
    browserHistory: isDevPreview ? saved.browserHistory : undefined,
    browserZoom: isDevPreview ? saved.browserZoom : undefined,
    devPreviewConsoleOpen: isDevPreview ? saved.devPreviewConsoleOpen : undefined,
    devPreviewConsoleTab:
      isDevPreview &&
      (saved.devPreviewConsoleTab === "console" ||
        saved.devPreviewConsoleTab === "output" ||
        saved.devPreviewConsoleTab === "diagnostics")
        ? saved.devPreviewConsoleTab
        : undefined,
    devPreviewScrollPosition: isDevPreview ? saved.devPreviewScrollPosition : undefined,
    exitBehavior: saved.exitBehavior,
    agentSessionId: reconnectedTerminal.agentSessionId ?? saved.agentSessionId,
    agentLaunchFlags: reconnectedTerminal.agentLaunchFlags ?? saved.agentLaunchFlags,
    agentModelId: reconnectedTerminal.agentModelId ?? saved.agentModelId,
    everDetectedAgent: reconnectedTerminal.everDetectedAgent,
    detectedAgentId: reconnectedTerminal.detectedAgentId,
    detectedProcessId: reconnectedTerminal.detectedProcessId,
    agentPresetId: readPresetId(saved) ?? reconnectedTerminal.agentPresetId,
    agentPresetColor: readPresetColor(saved) ?? reconnectedTerminal.agentPresetColor,
    originalPresetId:
      saved.originalPresetId ??
      reconnectedTerminal.originalAgentPresetId ??
      readPresetId(saved) ??
      reconnectedTerminal.agentPresetId,
    // Carry the captured launch env forward so a reconnect re-serializes the
    // snapshot WITH env rather than dropping it and reintroducing the provider
    // swap on the next full restart (#10922). Not used to spawn — PTY has it.
    env: sanitizeAgentEnv(saved.env),
    isUsingFallback: saved.isUsingFallback,
    fallbackChainIndex: saved.fallbackChainIndex,
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
    lastActiveAt: sanitizeLastActiveAt(saved.lastActiveAt),
  };
}

export function buildArgsForRespawn(
  saved: SavedTerminalData,
  kind: PanelKind,
  projectRoot: string,
  agentSettings: AgentSettingsData | undefined,
  reconnectTimedOut: boolean,
  clipboardDirectory: string | undefined,
  projectPresetsByAgent?: Record<string, AgentPreset[]>
): AddTerminalArgs {
  // Migrate legacy on-disk agentId/type to launchAgentId at the read boundary.
  const savedLaunchAgentId =
    saved.launchAgentId ?? (saved.type === "claude" ? "claude" : saved.agentId);
  let effectiveAgentId = resolveAgentId(savedLaunchAgentId);
  effectiveAgentId = inferAgentIdFromTitle(
    saved.title,
    kind,
    effectiveAgentId,
    saved.id,
    "Respawn"
  );

  const isAgentPanel = Boolean(effectiveAgentId);
  const agentId = effectiveAgentId;
  let command = saved.command?.trim() || undefined;
  // True when we fall through to a fresh agent launch because no resume command
  // was available — the user's prior conversation is unreachable and we must
  // surface it rather than silently respawning a clean session (issue #9802).
  let sessionLostOnRestore = false;
  let presetEnv: Record<string, string> | undefined;
  let preset: AgentPreset | undefined;
  // Bypass-reconciled launch flags (#10432); falls back to the raw saved flags
  // for non-agent panels that never enter the reconciliation branch below.
  let reconciledLaunchFlags: string[] | undefined;
  const savedPresetIdForRespawn = readPresetId(saved);
  const savedPresetColorForRespawn = readPresetColor(saved);
  let presetWasStale = false;

  if (agentId) {
    const agentConfig = getAgentConfig(agentId);
    const baseCommand = agentConfig?.command || agentId;
    const baseEntry = agentSettings?.agents?.[agentId] ?? {};
    const shareClipboardDirectory = baseEntry.shareClipboardDirectory as boolean | undefined;
    const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[agentId];
    const runtimeSettings = resolveAgentRuntimeSettings({
      agentId,
      presetId: savedPresetIdForRespawn,
      entry: baseEntry,
      ccrPresets,
      projectPresets: projectPresetsByAgent?.[agentId],
    });
    preset = runtimeSettings.preset;
    presetWasStale = !!savedPresetIdForRespawn && runtimeSettings.presetWasStale;
    const effectiveEntry = runtimeSettings.effectiveEntry;
    presetEnv = runtimeSettings.env;

    // Reconcile the persisted bypass flag against the current effective setting
    // (#10432, the "resume trap"): a snapshot captured while the global
    // skip-permissions switch was on must not carry the bypass flag forward
    // once it's toggled off, and vice-versa. Strip-and-re-add against the
    // current resolution so every restart/restore replays clean flags.
    const globalSkipPermissions = agentSettings?.globalSkipPermissions ?? false;
    const globalUseAltScreen = agentSettings?.globalUseAltScreen ?? false;
    const effectiveBypass = resolveEffectiveBypass(effectiveEntry, agentId, globalSkipPermissions);
    const effectiveInline = resolveEffectiveInlineMode(effectiveEntry, agentId, globalUseAltScreen);
    const dangerousArgs = effectiveEntry.dangerousArgs as string | undefined;
    const rawPersistedFlags = presetWasStale ? undefined : saved.agentLaunchFlags;
    const hasPersistedFlags = Boolean(rawPersistedFlags && rawPersistedFlags.length > 0);
    // Reconcile the persisted snapshot against both live resolutions (#10432 the
    // bypass token, #10876 the `--no-alt-screen` inline flag): a snapshot must
    // not carry a stale flag forward once the global switch or per-agent choice
    // is flipped. Applied together so restart/restore/resume replay clean flags.
    const reconcileFlags = (base: string[]): string[] =>
      reconcileInlineModeFlag(
        reconcileBypassFlags(base, agentId, effectiveBypass, dangerousArgs),
        agentId,
        effectiveInline
      );
    // Reconcile only the flags actually captured: this drives the stored
    // snapshot and the from-flags rebuild, so it must NOT synthesize a flag set
    // out of nothing (that would mask the fresh-launch fallback).
    const persistedFlags = hasPersistedFlags
      ? reconcileFlags(rawPersistedFlags as string[])
      : rawPersistedFlags;
    reconciledLaunchFlags = persistedFlags;
    // Resume commands prepend launch flags, so the bypass / inline tokens must be
    // injected even when no flags were captured — a session launched before
    // either feature existed should honour the current resolution (#10432, #10876).
    // Only diverges from persistedFlags in that inject-from-empty case.
    const injectedFromEmpty = reconcileFlags([]);
    const resumeFlags =
      !hasPersistedFlags && injectedFromEmpty.length > 0 ? injectedFromEmpty : persistedFlags;

    const buildFromPersistedFlags = () =>
      buildLaunchCommandFromFlags(baseCommand, agentId, persistedFlags as string[], {
        clipboardDirectory,
        shareClipboardDirectory,
      });

    if (saved.agentSessionId) {
      const resumeCmd = buildResumeCommand(agentId, saved.agentSessionId, resumeFlags);
      if (resumeCmd) {
        command = resumeCmd;
      } else if (hasPersistedFlags) {
        command = buildFromPersistedFlags();
        sessionLostOnRestore = true;
      } else if (agentSettings) {
        command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
          clipboardDirectory,
          modelId: saved.agentModelId,
          presetArgs: preset?.args?.join(" "),
          globalSkipPermissions,
          globalUseAltScreen,
        });
        sessionLostOnRestore = true;
      }
    } else {
      // No session ID was captured (graceful-shutdown pattern match missed or
      // timed out). Try the agent's resume-latest fallback before falling
      // through to a fresh launch so the user keeps their prior conversation.
      const resumeLatestCmd = buildResumeLatestCommand(agentId, resumeFlags);
      if (resumeLatestCmd) {
        command = resumeLatestCmd;
      } else if (hasPersistedFlags) {
        command = buildFromPersistedFlags();
        sessionLostOnRestore = true;
      } else if (agentSettings) {
        command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
          clipboardDirectory,
          modelId: saved.agentModelId,
          presetArgs: preset?.args?.join(" "),
          globalSkipPermissions,
          globalUseAltScreen,
        });
        sessionLostOnRestore = true;
      }
    }
  }

  const respawnKind = normalizePtyKind(kind);
  const isDevPreview = kind === "dev-preview";
  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

  // Stale-preset split-brain: when saved.agentPresetId was set but the preset
  // no longer resolves (deleted custom preset, CCR route removed from config),
  // clear agentPresetId/agentPresetColor and strip the preset suffix from the
  // title so the respawned panel doesn't lie about its preset identity. Note the
  // captured launch env (`env` below) is still replayed independently (#10922) —
  // a deleted preset shouldn't silently swap a live session's provider — so the
  // command/env are not necessarily "default" here, only the preset badge is.
  presetWasStale = isAgentPanel && presetWasStale;
  const respawnAgentPresetId = presetWasStale ? undefined : savedPresetIdForRespawn;
  const respawnAgentPresetColor = presetWasStale
    ? undefined
    : (preset?.color ?? savedPresetColorForRespawn);
  const respawnOriginalPresetId = presetWasStale
    ? undefined
    : (saved.originalPresetId ?? savedPresetIdForRespawn);
  // A user-locked title never contains preset branding — stripping it on a
  // stale preset would destroy a human rename, so the lock exempts it.
  const userLockedTitle = saved.titleMode === "user";
  const respawnTitle =
    presetWasStale && !userLockedTitle
      ? (agentId ? getAgentConfig(agentId)?.name : saved.title) || saved.title
      : saved.title;

  return {
    kind: respawnKind,
    launchAgentId: agentId,
    title: respawnTitle,
    // A stale preset's pinned title was just stripped — drop the pin with it
    // (unless the user locked the title, which the strip above exempts).
    titleMode: presetWasStale && !userLockedTitle ? undefined : saved.titleMode,
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
    agentLaunchFlags: presetWasStale
      ? undefined
      : (reconciledLaunchFlags ?? saved.agentLaunchFlags),
    agentModelId: saved.agentModelId,
    agentPresetId: respawnAgentPresetId,
    agentPresetColor: respawnAgentPresetColor,
    originalPresetId: respawnOriginalPresetId,
    isUsingFallback: presetWasStale ? undefined : saved.isUsingFallback,
    fallbackChainIndex: presetWasStale ? undefined : saved.fallbackChainIndex,
    sessionLostOnRestore: sessionLostOnRestore || undefined,
    // Prefer the launch env captured in the snapshot (#10922) so the restored
    // session replays the same provider environment (e.g. a Z.AI/GLM preset or a
    // recipe's inline env) even when that preset/recipe no longer resolves in the
    // current store. Falls back to live re-resolution for legacy snapshots saved
    // before env was persisted, or when the saved env sanitizes to nothing safe.
    env: sanitizeAgentEnv(saved.env) ?? presetEnv,
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
    restore: true,
    lastActiveAt: sanitizeLastActiveAt(saved.lastActiveAt),
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
    titleMode: saved.titleMode,
    cwd: resolveSavedCwd(saved.cwd, projectRoot),
    worktreeId: saved.worktreeId,
    location,
    requestedId: saved.id,
    exitBehavior: saved.exitBehavior,
    agentPresetId: readPresetId(saved),
    agentPresetColor: readPresetColor(saved),
    originalPresetId: saved.originalPresetId ?? readPresetId(saved),
    isUsingFallback: saved.isUsingFallback,
    fallbackChainIndex: saved.fallbackChainIndex,
    extensionState: saved.extensionState,
    pluginId: saved.pluginId,
    lastActiveAt: sanitizeLastActiveAt(saved.lastActiveAt),
  };

  const deserializer = getDeserializer(kind);
  if (deserializer) {
    return { ...base, ...deserializer(saved) };
  }

  return base;
}

// Moved to a standalone module so renderer-pure consumers (resume grouping,
// resume launch) can use it without pulling in the hydration import graph.
// Re-exported here for the existing hydration-side callers.
export { inferWorktreeIdFromCwd } from "../worktreePaths";

export function buildArgsForOrphanedTerminal(
  terminal: BackendTerminalData,
  projectRoot: string
): AddTerminalArgs {
  const cwd = terminal.cwd || projectRoot || "";
  let launchAgentId = resolveAgentId(terminal.launchAgentId);
  launchAgentId = inferAgentIdFromTitle(
    terminal.title,
    terminal.kind,
    launchAgentId,
    terminal.id,
    "Orphaned"
  );

  return {
    kind: normalizePtyKind(terminal.kind),
    launchAgentId,
    title: terminal.title,
    cwd,
    location: "grid",
    existingId: terminal.id,
    agentState: coerceAgentState(terminal.agentState),
    waitingReason: restoredWaitingReason(terminal),
    lastStateChange: terminal.lastStateChange,
    agentSessionId: terminal.agentSessionId,
    agentLaunchFlags: terminal.agentLaunchFlags,
    agentModelId: terminal.agentModelId,
    everDetectedAgent: terminal.everDetectedAgent,
    detectedAgentId: terminal.detectedAgentId,
    detectedProcessId: terminal.detectedProcessId,
    agentPresetId: terminal.agentPresetId,
    agentPresetColor: terminal.agentPresetColor,
    originalPresetId: terminal.originalAgentPresetId ?? terminal.agentPresetId,
  };
}
