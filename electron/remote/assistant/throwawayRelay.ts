import {
  THROWAWAY_CLOSE_TOOL,
  THROWAWAY_LAUNCH_TOOL,
  THROWAWAY_SEND_COMMAND_TOOL,
  THROWAWAY_SEND_KEYS_TOOL,
  type HostThrowawayCall,
  type HostThrowawayFailure,
  type HostThrowawayRefusal,
  type HostThrowawayTool,
} from "../../../shared/types/hostThrowaway.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import type { ThrowawayCallAnswer, ThrowawayCallPayload } from "./linkMethods.js";
import { RelayCallLedger } from "./relayCallLedger.js";

declare module "../runtime.js" {
  interface RemoteServices {
    /** This host's own throwaway runs (#14445); unregistered, every throwaway call reads as off. */
    hostThrowawayRuns: HostThrowawayExecutor;
  }
}

/** Who a throwaway run belongs to: the sender this host authenticated and its help session. */
export interface HostThrowawayOwner {
  senderId: string;
  helpSessionId: string;
}

/** What the executor answers for one tool: it ran, it ran and failed, or it wouldn't run it. */
export type HostThrowawayExecution =
  | Extract<ThrowawayCallAnswer, { status: "done" | "failed" }>
  | { status: "refused"; reason: Exclude<HostThrowawayRefusal, "control-off"> };

/**
 * Runs throwaway tools on this host, with no view and no project (#14445).
 * It answers `not-found` for any run that isn't `owner`'s. The relay has
 * already checked consent and made the call at most once per callId.
 */
export interface HostThrowawayExecutor {
  run(
    owner: HostThrowawayOwner,
    call: HostThrowawayCall,
    options: { callId: string; timeoutMs: number }
  ): Promise<HostThrowawayExecution>;
}

export interface ThrowawayRelayDeps {
  /** This machine's own consent to work run for other machines' assistants, read at each call. */
  acceptsRemoteControl(): boolean;
  /** Read at each call; null while this host has no throwaway runs to offer. */
  executor(): HostThrowawayExecutor | null;
  now?: () => number;
}

export interface ThrowawayRelay {
  /** Runs one throwaway tool for a sender, at most once per callId. */
  call(senderId: string, payload: ThrowawayCallPayload): Promise<ThrowawayCallAnswer>;
  dispose(): void;
}

/** What an executor that threw reads as, for the tools whose throw says what failed. */
const THROWN_FAILURES: Partial<Record<HostThrowawayTool, HostThrowawayFailure>> = {
  [THROWAWAY_LAUNCH_TOOL]: "launch-failed",
  [THROWAWAY_SEND_COMMAND_TOOL]: "input-failed",
  [THROWAWAY_SEND_KEYS_TOOL]: "input-failed",
  [THROWAWAY_CLOSE_TOOL]: "close-failed",
};

/**
 * The relay's side of a throwaway call (#14446), whichever way it came: over
 * a Shell's link or from one of this machine's own assistants. It never
 * opens an MCP session, reads a project or routes to a view, so a window that
 * is stuck, switching or holding a lease changes nothing here. Calls are at
 * most once per sender and callId, so a resent launch never launches twice.
 */
export function createThrowawayRelay(deps: ThrowawayRelayDeps): ThrowawayRelay {
  const ledger = new RelayCallLedger<ThrowawayCallAnswer>(deps.now ? { now: deps.now } : {});

  const execute = async (
    senderId: string,
    payload: ThrowawayCallPayload
  ): Promise<ThrowawayCallAnswer> => {
    if (!deps.acceptsRemoteControl()) return { status: "refused", reason: "control-off" };
    const executor = deps.executor();
    if (executor === null) return { status: "refused", reason: "throwaway-off" };
    try {
      return await executor.run({ senderId, helpSessionId: payload.helpSessionId }, payload.call, {
        callId: payload.callId,
        timeoutMs: payload.runMs,
      });
    } catch (error) {
      const failure = THROWN_FAILURES[payload.call.tool];
      if (failure === undefined) throw error;
      return { status: "failed", reason: failure };
    }
  };

  return {
    call: async (senderId, payload) => {
      // No timer of its own: a host nobody calls holds nothing to sweep for long.
      ledger.sweep();
      const digest = canonicalArgsHash(payload.call.tool, {
        helpSessionId: payload.helpSessionId,
        tier: payload.tier,
        throwaway: true,
        args: payload.call.args,
      });
      const answer = await ledger.run(senderId, payload.callId, digest, payload.resend, () =>
        execute(senderId, payload)
      );
      if (answer.status === "answered") return answer.value;
      return { status: answer.status };
    },
    dispose: () => ledger.clear(),
  };
}
