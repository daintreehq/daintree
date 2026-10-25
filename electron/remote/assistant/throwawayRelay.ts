import {
  THROWAWAY_CLOSE_TOOL,
  THROWAWAY_LAUNCH_TOOL,
  THROWAWAY_OUTPUT_TOOL,
  THROWAWAY_SEND_COMMAND_TOOL,
  THROWAWAY_SEND_KEYS_TOOL,
  type HostThrowawayCall,
  type HostThrowawayFailure,
  type HostThrowawayRefusal,
  type HostThrowawayTool,
} from "../../../shared/types/hostThrowaway.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  MAX_RELAY_RESULT_BYTES,
  ThrowawayCallAnswerSchema,
  type ThrowawayCallAnswer,
  type ThrowawayCallPayload,
} from "./linkMethods.js";
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

/**
 * Why a run's owner can make no more calls (#14447): its help session ended,
 * or its Shell's last link to this host went.
 */
export type HostThrowawayOwnerGone = "session-ended" | "shell-gone";

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
  /**
   * Closes the runs of an owner that will make no more calls, without waiting
   * out their time limits: one help session's, or with none named, every run
   * of the sender.
   */
  endOwner(
    owner: { senderId: string; helpSessionId?: string },
    reason: HostThrowawayOwnerGone
  ): void;
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

/** Room the answer's own fields take beside an output read's text. */
const ANSWER_ENVELOPE_BYTES = 4 * 1024;

function invalidExecution(): AppError {
  // Thrown, never retried: what ran may already have changed something.
  return new AppError({ code: "INTERNAL", message: "The throwaway executor's answer was invalid" });
}

/**
 * What the executor answered, as the Shell's schema will read it, for the
 * tool that was called. An output read too large to carry keeps its last
 * lines, as a terminal's tail is what a check reads.
 */
function checkedAnswer(
  call: HostThrowawayCall,
  answer: HostThrowawayExecution
): ThrowawayCallAnswer {
  const parsed = ThrowawayCallAnswerSchema.safeParse(answer);
  if (!parsed.success) throw invalidExecution();
  const checked = parsed.data;
  if (checked.status !== "done") return checked;
  if (checked.result.tool !== call.tool) throw invalidExecution();
  if (checked.result.tool !== THROWAWAY_OUTPUT_TOOL) return checked;
  const budget = MAX_RELAY_RESULT_BYTES - ANSWER_ENVELOPE_BYTES;
  const { content } = checked.result;
  if (Buffer.byteLength(JSON.stringify(content), "utf8") <= budget) return checked;
  const lines = content.split("\n");
  let kept = 0;
  let bytes = 2;
  for (let index = lines.length - 1; index >= 0; index--) {
    // Its escaped text and the escaped newline before it.
    const size = Buffer.byteLength(JSON.stringify(lines[index]), "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    kept += 1;
  }
  const tail = lines.slice(lines.length - kept);
  return {
    status: "done",
    result: {
      ...checked.result,
      content: tail.join("\n"),
      lineCount: tail.length,
      truncated: true,
    },
  };
}

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
    let answer: HostThrowawayExecution;
    try {
      answer = await executor.run(
        { senderId, helpSessionId: payload.helpSessionId },
        payload.call,
        {
          callId: payload.callId,
          timeoutMs: payload.runMs,
        }
      );
    } catch (error) {
      const failure = THROWN_FAILURES[payload.call.tool];
      if (failure === undefined) throw error;
      return { status: "failed", reason: failure };
    }
    return checkedAnswer(payload.call, answer);
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
