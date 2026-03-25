import type { TerminalKind, TerminalType, AgentState } from "@/types";
import type { BrowserHistory } from "@shared/types/browser";
import type { PanelExitBehavior } from "@shared/types/panel";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { generateAgentCommand, buildResumeCommand } from "@shared/types";
import { logWarn } from "@/utils/logger";

export interface AddTerminalArgs {
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: string;
  title?: string;
  cwd: string;
  worktreeId?: string;
  location?: "grid" | "dock";
  command?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  existingId?: string;
  requestedId?: string;
  skipCommandExecution?: boolean;
  isInputLocked?: boolean;
  browserUrl?: string;
  browserHistory?: BrowserHistory;
  browserZoom?: number;
  browserConsoleOpen?: boolean;
  notePath?: string;
  noteId?: string;
  scope?: "worktree" | "project";
  createdAt?: number;
  devCommand?: string;
  devServerStatus?: "stopped" | "starting" | "installing" | "running" | "error";
  devServerUrl?: string | null;
  devServerError?: { type: string; message: string } | null;
  devServerTerminalId?: string | null;
  devPreviewConsoleOpen?: boolean;
  exitBehavior?: PanelExitBehavior;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
  restore?: boolean;
  bypassLimits?: boolean;
}

export interface SavedTerminalData {
  id: string;
  kind?: TerminalKind;
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
  notePath?: string;
  noteId?: string;
  scope?: string;
  createdAt?: number;
  devCommand?: string;
  devPreviewConsoleOpen?: boolean;
  exitBehavior?: PanelExitBehavior;
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
}

interface BackendTerminalData {
  id: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: string;
  title?: string;
  cwd: string;
  worktreeId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  activityTier?: "active" | "background";
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
}

interface ReconnectedTerminalData {
  id?: string;
  kind?: TerminalKind;
  type?: TerminalType;
  agentId?: string;
  title?: string;
  cwd?: string;
  worktreeId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  activityTier?: "active" | "background";
  agentSessionId?: string;
  agentLaunchFlags?: string[];
  agentModelId?: string;
}

interface AgentSettingsData {
  agents?: Record<string, Record<string, unknown>>;
}

export function inferAgentIdFromTitle(
  title: string | undefined,
  kind: TerminalKind | undefined,
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

export function inferKind(saved: SavedTerminalData): TerminalKind {
  if (saved.kind) return saved.kind;
  if (saved.browserUrl !== undefined) return "browser";
  if (saved.notePath !== undefined || saved.noteId !== undefined) return "notes";
  if (saved.title === "Assistant" || saved.title?.startsWith("Assistant")) return "assistant";
  if (!saved.cwd && !saved.command) return "assistant";
  return "terminal";
}

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
    title: backendTerminal.title,
    cwd,
    worktreeId: backendTerminal.worktreeId,
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
    title: reconnectedTerminal.title ?? saved.title,
    cwd,
    worktreeId: reconnectedTerminal.worktreeId ?? saved.worktreeId,
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
  };
}

export function buildArgsForRespawn(
  saved: SavedTerminalData,
  kind: TerminalKind,
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

  if (agentId) {
    if (saved.agentSessionId) {
      const resumeCmd = buildResumeCommand(agentId, saved.agentSessionId, saved.agentLaunchFlags);
      if (resumeCmd) {
        command = resumeCmd;
      } else if (agentSettings) {
        const agentConfig = getAgentConfig(agentId);
        const baseCommand = agentConfig?.command || agentId;
        command = generateAgentCommand(
          baseCommand,
          agentSettings.agents?.[agentId] ?? {},
          agentId,
          { clipboardDirectory, modelId: saved.agentModelId }
        );
      }
    } else if (agentSettings) {
      const agentConfig = getAgentConfig(agentId);
      const baseCommand = agentConfig?.command || agentId;
      command = generateAgentCommand(baseCommand, agentSettings.agents?.[agentId] ?? {}, agentId, {
        clipboardDirectory,
        modelId: saved.agentModelId,
      });
    }
  }

  const respawnKind = isAgentPanel ? "agent" : kind;
  const isDevPreview = kind === "dev-preview";
  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

  return {
    kind: respawnKind,
    type: saved.type,
    agentId,
    title: saved.title,
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
    restore: true,
  };
}

export function buildArgsForNonPtyRecreation(
  saved: SavedTerminalData,
  kind: TerminalKind,
  projectRoot: string
): AddTerminalArgs {
  const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";
  const devCommandCandidate = kind === "dev-preview" ? saved.devCommand?.trim() : undefined;
  const devCommand =
    kind === "dev-preview" ? devCommandCandidate || saved.command?.trim() || undefined : undefined;

  return {
    kind,
    title: saved.title,
    cwd: saved.cwd || projectRoot || "",
    worktreeId: saved.worktreeId,
    location,
    requestedId: saved.id,
    browserUrl: saved.browserUrl,
    browserHistory: saved.browserHistory,
    browserZoom: saved.browserZoom,
    browserConsoleOpen: kind === "browser" ? saved.browserConsoleOpen : undefined,
    notePath: saved.notePath,
    noteId: saved.noteId,
    scope: saved.scope as "worktree" | "project" | undefined,
    createdAt: saved.createdAt,
    devCommand,
    devPreviewConsoleOpen: kind === "dev-preview" ? saved.devPreviewConsoleOpen : undefined,
    exitBehavior: saved.exitBehavior,
  };
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
    worktreeId: terminal.worktreeId,
    location: "grid",
    existingId: terminal.id,
    agentState: terminal.agentState,
    lastStateChange: terminal.lastStateChange,
    agentSessionId: terminal.agentSessionId,
    agentLaunchFlags: terminal.agentLaunchFlags,
    agentModelId: terminal.agentModelId,
  };
}
