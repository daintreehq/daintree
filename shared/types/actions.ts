import type { KeyAction } from "./keymap.js";
import type { z } from "zod";

export type ActionSource = "user" | "keybinding" | "menu" | "agent";

export type ActionKind = "command" | "query";

export type ActionDanger = "safe" | "confirm" | "restricted";

export type ActionScope = "renderer";

export type ActionId =
  | KeyAction
  | "agent.launch"
  | "app.settings.openTab"
  | "worktree.createDialog.open"
  | "actions.list"
  | "actions.getContext";

export interface ActionContext {
  projectId?: string;
  activeWorktreeId?: string;
  focusedTerminalId?: string;
  isTerminalPaletteOpen?: boolean;
  isSettingsOpen?: boolean;
}

export interface ActionDefinition<Args = unknown, Result = unknown> {
  id: ActionId;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  scope: ActionScope;
  argsSchema?: z.ZodType<Args>;
  resultSchema?: z.ZodType<Result>;
  isEnabled?: (ctx: ActionContext) => boolean;
  disabledReason?: (ctx: ActionContext) => string | undefined;
  run: (args: Args, ctx: ActionContext) => Promise<Result>;
}

export interface ActionManifestEntry {
  id: ActionId;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  enabled: boolean;
  disabledReason?: string;
}

export interface ActionDispatchSuccess<Result = unknown> {
  ok: true;
  result: Result;
}

export interface ActionDispatchError {
  ok: false;
  error: ActionError;
}

export type ActionDispatchResult<Result = unknown> =
  | ActionDispatchSuccess<Result>
  | ActionDispatchError;

export type ActionErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "DISABLED"
  | "RESTRICTED"
  | "EXECUTION_ERROR";

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  details?: unknown;
}

export interface ActionDispatchOptions {
  source?: ActionSource;
}

export interface ActionDispatchPayload {
  actionId: ActionId;
  args?: unknown;
  context: ActionContext;
  source: ActionSource;
  timestamp: number;
}
