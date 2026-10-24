import { GLOBAL_ASSISTANT_ID } from "../../../shared/config/globalAssistant.js";
import type { McpTier } from "./shared.js";
import type { SessionSurfacePolicy } from "./tierAuth.js";
import type { AssistantCaller } from "../assistants/AssistantTerminalControl.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";

/**
 * What every request handler of one MCP session reads about that session.
 * Built once per session; every field is fixed for its life, and the
 * predicates read live state on each call rather than caching it.
 */
export interface SessionContext {
  readonly sessionId: string;
  readonly deps: SessionServerDeps;
  readonly sessionSurface: Readonly<SessionSurfacePolicy>;
  readonly isGlobalSession: () => boolean;
  readonly hostCallOffered: () => boolean;
  readonly assistantCallerNow: () => AssistantCaller | null;
  readonly mayNameTerminal: (tier: McpTier, terminalId: string) => boolean;
}

export function createSessionContext(sessionId: string, deps: SessionServerDeps): SessionContext {
  const { sessionStore, workspaceBinding, hostControl, assistantControl, requestApproval } = deps;

  /**
   * Whether every call from this session routes to one bound workspace
   * (#11789).
   *
   * Captured from the handshake binding, NOT read live off
   * `sessionWorkspaceMap`. The binding is immutable for the session's life — it
   * is written once at handshake and only ever deleted at teardown — so a live
   * read buys nothing and costs correctness: routing captures the same value
   * once (`boundWorkspaceId` in `buildSessionServerDeps`), so a live read here
   * would let teardown strip the confirm-gated ceiling from a call whose
   * dispatch closure still targets the bound workspace. The two must share one
   * lifetime, and the handshake value is the one that cannot go stale.
   */
  const sessionSurface: SessionSurfacePolicy = {
    workspaceBound: workspaceBinding !== undefined,
    // Only an agent pane is handed an approval route (#12692).
    paneApproval: requestApproval !== undefined,
    paneSkipConfirmations: requestApproval !== undefined && deps.paneSkipConfirmations === true,
    relay: deps.relay !== undefined,
  };

  // `host.list` and `host.call` (#13493): any of this machine's own
  // assistants, from its start and whether or not a host exists yet. Read per
  // listing, never cached.
  const isGlobalSession = (): boolean =>
    sessionStore.sessionViewlessHelpMap.get(sessionId) === GLOBAL_ASSISTANT_ID;
  const hostCallOffered = (): boolean =>
    hostControl !== undefined &&
    sessionStore.sessionHelpIdMap.has(sessionId) &&
    hostControl.isCallReachable();
  // Whether this session is an assistant that may address another (#13496).
  // Read per listing and per call, never cached: a help session's lane can
  // end under it.
  const assistantCallerNow = (): AssistantCaller | null =>
    assistantControl !== undefined ? (deps.assistantCaller?.() ?? null) : null;
  // Whether a read outside the tool calls' own gate may name this terminal
  // (#13496): an assistant's only for an assistant caller it resolves for.
  const mayNameTerminal = (tier: McpTier, terminalId: string): boolean => {
    if (assistantControl?.isAssistantTerminal(terminalId) !== true) return true;
    const caller = tier === "external" ? null : assistantCallerNow();
    return caller !== null && assistantControl.resolve(caller, terminalId) !== null;
  };

  return {
    sessionId,
    deps,
    sessionSurface,
    isGlobalSession,
    hostCallOffered,
    assistantCallerNow,
    mayNameTerminal,
  };
}
