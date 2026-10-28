import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { McpTier } from "./shared.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";

/**
 * What one `tools/call` was admitted as, captured before its first await so
 * every stage, audit record and strip event of the call reads the same
 * values (#10067, #12407).
 */
export interface CallFacts {
  readonly sessionId: string;
  readonly actionId: string;
  /** The caller's arguments, as the audit records them. Not a copy. */
  readonly args: unknown;
  readonly requestKey: string | undefined;
  readonly startedAt: number;
  readonly tier: McpTier;
  readonly capturedTurnId: string | null;
  readonly rendererOwnedOrigin: boolean;
}

/** Whether this caller is one of the few the caller-only tools admit (#13495, #13496). */
export interface CallerAdmission {
  readonly commandRunnerCaller: boolean;
  readonly assistantControlCaller: boolean;
}

/** The audit writer for one call, stamped with its relay callId when it has one. */
export type CallAuditWriter = SessionServerDeps["appendAuditRecord"];

export type CallOutcome =
  { kind: "result"; value: ActionDispatchResult } | { kind: "throw"; error: unknown };

/** A stage either lets its call go on with what it found, or answers it. */
export type CallGate<T> =
  | { readonly kind: "continue"; readonly value: T }
  | { readonly kind: "return"; readonly result: CallToolResult };
