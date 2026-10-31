import { createHash } from "node:crypto";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { LAUNCH_SETUP_WAIT_DEFAULT_MS } from "../../../shared/utils/launchInNewWorktree.js";
import {
  formatPartialSuccessMessage,
  parsePartialSuccessMessage,
} from "../../../shared/utils/partialSuccess.js";
import { MAX_WAIT_UNTIL_READY_TIMEOUT_MS } from "../../../shared/utils/worktreeSummary.js";
import { AgentLaunchInNewWorktreeArgsSchema } from "../viewless/viewlessArgsSchemas.js";
import { buildToolError } from "./shared.js";
import { buildToolCallResult } from "./toolCallResult.js";

export const AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL = "agent.launchInNewWorktree";

const CREATE_TOOL = "worktree.createWithRecipe";
const WAIT_TOOL = "worktree.waitUntilReady";
const LAUNCH_TOOL = "agent.launch";

const PARTIAL_SUCCESS_CODE = "PARTIAL_SUCCESS";

export interface LaunchInNewWorktreeDeps {
  /**
   * Run one step as its single call, back through the session's own call
   * handler, so tier, ownership, notices and audit apply to it exactly as if
   * the caller had made it.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  signal: AbortSignal;
  /**
   * The create step's idempotency key, from {@link createStepRequestKey}.
   * Without one, two different calls naming the same source would share the
   * create step's cached answer: the second agent would land in the first
   * call's worktree.
   */
  createRequestKey?: string;
  now?: () => number;
}

/**
 * The create step's request key, scoped to the composite call that made it,
 * so a different call naming the same source gets a worktree of its own
 * rather than the first call's cached create answer.
 */
export function createStepRequestKey(callDedupKey: string): string {
  return `${AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL}:${createHash("sha256").update(callDedupKey).digest("hex")}`;
}

export interface LaunchInNewWorktreeAnswer {
  result: CallToolResult;
  /** What the call's own audit record says it did. */
  outcome: ActionDispatchResult;
}

type Step = "create" | "setup" | "launch";

interface StepError {
  code: string;
  message: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** A call's value: its structured content, else its JSON text. */
function valueOf(result: CallToolResult): JsonRecord | undefined {
  if (result.structuredContent !== undefined) return asRecord(result.structuredContent);
  const first = result.content?.[0];
  if (first === undefined || first.type !== "text") return undefined;
  try {
    return asRecord(JSON.parse(first.text));
  } catch {
    return undefined;
  }
}

/** A failed call's code and message, as the error envelope carries them. */
function errorOf(result: CallToolResult): StepError {
  const value = valueOf(result);
  const code = typeof value?.code === "string" ? value.code : "EXECUTION_ERROR";
  const first = result.content?.[0];
  const message =
    typeof value?.message === "string"
      ? value.message
      : first !== undefined && first.type === "text"
        ? first.text
        : "The call failed without saying why.";
  return { code, message };
}

function thrownError(error: unknown): StepError {
  return {
    code:
      error instanceof McpError && error.code === ErrorCode.InvalidParams
        ? "VALIDATION_ERROR"
        : "EXECUTION_ERROR",
    message: formatErrorMessage(error, "The call failed"),
  };
}

/**
 * Validated arguments, or an `InvalidParams` refusal before anything is
 * created. The two keys a caller is most likely to carry over from the calls
 * this replaces are named, rather than left to a bare unknown-key error.
 */
function parseArgs(args: unknown) {
  const record = asRecord(args);
  if (record !== undefined && "worktreeId" in record) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL} creates its own worktree, so it takes no worktreeId. To launch into an existing worktree, call ${LAUNCH_TOOL}. Nothing was created.`
    );
  }
  if (record !== undefined && "recipeId" in record) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL} launches one agent and runs no recipe. For a recipe, call ${CREATE_TOOL}. Nothing was created.`
    );
  }
  const parsed = AgentLaunchInNewWorktreeArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new McpError(
      ErrorCode.InvalidParams,
      `${AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL}: ${issue?.message ?? "invalid arguments"}${
        issue && issue.path.length > 0 ? ` at '${issue.path.map(String).join(".")}'` : ""
      }. Nothing was created.`
    );
  }
  return parsed.data;
}

/**
 * A create step a view didn't answer before its dispatch deadline. Git may
 * have made the worktree after all, and nothing records it, so this is not
 * the retriable execution error it arrives as. A deadline that passed before
 * the create was sent started nothing, and stays as it came.
 */
const DISPATCH_TIMED_OUT = /^Action dispatch timed out\b(?!.*before it was sent)/;

function createUnconfirmed(detail: string): LaunchInNewWorktreeAnswer {
  const message = `The create step didn't answer before its dispatch deadline, so it isn't known whether a worktree was made, and nothing was launched. Check the worktree listing for the branch before calling again: a retry could make a second worktree. ${detail}`;
  return {
    result: buildToolError({ code: "CREATE_UNCONFIRMED", message, retriable: false }),
    outcome: { ok: false, error: { code: "EXECUTION_ERROR", message } },
  };
}

/** Why setup stopped the launch, for a wait that did not end ready. */
function setupStop(setup: JsonRecord, waitedMs: number): StepError {
  const state = typeof setup.setupState === "string" ? setup.setupState : "unknown";
  const stage = typeof setup.stage === "string" ? ` at ${setup.stage}` : "";
  const detail = typeof setup.error === "string" && setup.error ? `: ${setup.error}` : "";
  if (setup.timedOut === true) {
    return {
      code: "SETUP_STILL_RUNNING",
      message: `Setup was still ${state}${stage} after ${waitedMs} ms, so the agent wasn't launched.`,
    };
  }
  switch (state) {
    case "failed":
      return {
        code: "SETUP_FAILED",
        message: `Setup failed${stage}${detail}, so the agent wasn't launched.`,
      };
    case "timed-out":
      return {
        code: "SETUP_TIMED_OUT",
        message: `Setup timed out${stage}${detail}, so the agent wasn't launched.`,
      };
    case "needs-approval":
      return {
        code: "SETUP_NEEDS_APPROVAL",
        message:
          "Setup is waiting for the user's approval, which this call can't give, so the agent wasn't launched.",
      };
    default:
      return {
        code: "SETUP_UNKNOWN",
        message: `The host reported setup as ${state}, not ready, so the agent wasn't launched.`,
      };
  }
}

/**
 * `agent.launchInNewWorktree` (#15738): create a worktree, wait for its setup,
 * and launch an agent in it, each step as its own single call. Running them
 * through the session's own handler is what makes the session own the
 * worktree and the pane exactly as the separate calls would, lets the launch's
 * notice and reply wait work as they do on `agent.launch`, and lets each step
 * dispatch with no view where its single call can.
 *
 * Once the worktree exists, every failure says so: it is answered as
 * `PARTIAL_SUCCESS` with the worktree's id and the step that stopped, never as
 * a bare error a caller would retry into a second worktree. Nothing created is
 * rolled back.
 */
export async function runLaunchInNewWorktree(
  args: unknown,
  deps: LaunchInNewWorktreeDeps
): Promise<LaunchInNewWorktreeAnswer> {
  const { source, setupTimeoutMs = LAUNCH_SETUP_WAIT_DEFAULT_MS, ...launch } = parseArgs(args);
  const now = deps.now ?? Date.now;

  if (deps.signal.aborted) {
    const message = "The call was cancelled before anything was created.";
    return {
      result: buildToolError({ code: "CANCELLED", message }),
      outcome: { ok: false, error: { code: "EXECUTION_ERROR", message } },
    };
  }

  // Filled in as each step answers, so a stop reports everything that exists.
  let creation: JsonRecord | undefined;
  let setup: JsonRecord | undefined;
  const stopped = (
    step: Step,
    error: StepError,
    launchValue?: JsonRecord
  ): LaunchInNewWorktreeAnswer => {
    const id = String(creation?.worktreeId);
    const partialResult: JsonRecord = {
      worktreeId: id,
      stoppedAt: step,
      error,
      creation: creation ?? null,
      setup: setup ?? null,
      launch: launchValue ?? null,
    };
    const message = `${error.message} Worktree ${id} was created and this session owns it: launch into it with ${LAUNCH_TOOL} once ${WAIT_TOOL} says ready, or delete it with worktree.deleteOwned. Calling ${AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL} again makes a second worktree.`;
    const formatted = formatPartialSuccessMessage(message, partialResult);
    return {
      result: buildToolError({
        code: PARTIAL_SUCCESS_CODE,
        message: formatted,
        details: { partialResult },
        retriable: false,
      }),
      outcome: { ok: false, error: { code: "PARTIAL_SUCCESS", message: formatted } },
    };
  };

  const createdResult = await deps.callTool(CREATE_TOOL, {
    source,
    ...(deps.createRequestKey !== undefined ? { requestKey: deps.createRequestKey } : {}),
  });
  if (createdResult.isError === true) {
    const error = errorOf(createdResult);
    // The code is stamped only for a composite's own partial failure, never
    // read off message text, so a forge or git message shaped like one can't
    // claim a worktree exists.
    const partial =
      error.code === PARTIAL_SUCCESS_CODE ? parsePartialSuccessMessage(error.message) : null;
    if (partial === null || typeof partial.partialResult.worktreeId !== "string") {
      if (DISPATCH_TIMED_OUT.test(error.message)) return createUnconfirmed(error.message);
      return {
        result: createdResult,
        outcome: { ok: false, error: { code: "EXECUTION_ERROR", message: error.message } },
      };
    }
    creation = partial.partialResult;
    return stopped("create", { code: PARTIAL_SUCCESS_CODE, message: partial.message });
  }
  creation = valueOf(createdResult);
  const worktreeId = creation?.worktreeId;
  if (typeof worktreeId !== "string") {
    const message = `${CREATE_TOOL} answered without a worktreeId, so nothing was launched.`;
    return {
      result: buildToolError({ code: "EXECUTION_ERROR", message }),
      outcome: { ok: false, error: { code: "EXECUTION_ERROR", message } },
    };
  }

  // Waited in slices: one wait is bounded by the renderer's dispatch wall, and
  // the budget here is the caller's. The slice count bounds the loop even if
  // a wait came back early every time.
  const startedWaiting = now();
  const deadline = startedWaiting + setupTimeoutMs;
  const maxSlices = Math.ceil(setupTimeoutMs / MAX_WAIT_UNTIL_READY_TIMEOUT_MS) + 1;
  for (let slice = 0; slice < maxSlices; slice++) {
    if (deps.signal.aborted) {
      return stopped("setup", {
        code: "CANCELLED",
        message: "The call was cancelled while setup ran, so the agent wasn't launched.",
      });
    }
    const timeoutMs = Math.min(MAX_WAIT_UNTIL_READY_TIMEOUT_MS, Math.max(0, deadline - now()));
    let waited: CallToolResult;
    try {
      waited = await deps.callTool(WAIT_TOOL, { worktreeId, timeoutMs });
    } catch (error) {
      return stopped("setup", thrownError(error));
    }
    if (waited.isError === true) return stopped("setup", errorOf(waited));
    setup = valueOf(waited) ?? { setupState: "unknown", timedOut: false };
    if (setup.timedOut !== true || now() >= deadline) break;
  }
  if (setup?.setupState !== "ready") {
    return stopped("setup", setupStop(setup ?? {}, now() - startedWaiting));
  }

  if (deps.signal.aborted) {
    return stopped("launch", {
      code: "CANCELLED",
      message: "The call was cancelled once setup was ready, so the agent wasn't launched.",
    });
  }
  let launched: CallToolResult;
  try {
    launched = await deps.callTool(LAUNCH_TOOL, { ...launch, worktreeId });
  } catch (error) {
    return stopped("launch", thrownError(error));
  }
  if (launched.isError === true) return stopped("launch", errorOf(launched));
  const launchValue = valueOf(launched);
  if (launchValue === undefined || launchValue.launched === false) {
    const status =
      typeof launchValue?.spawnStatus === "string" ? launchValue.spawnStatus : "unknown";
    return stopped(
      "launch",
      { code: "LAUNCH_DECLINED", message: `The agent didn't launch (${status}).` },
      launchValue
    );
  }

  const value: JsonRecord = { ...launchValue, creation, setup };
  return {
    result: buildToolCallResult(value, { structuredContent: value }),
    outcome: { ok: true, result: value },
  };
}
