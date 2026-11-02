import { GLOBAL_ASSISTANT_TOOL_IDS } from "../../../shared/config/globalAssistant.js";
import { randomBytes, randomUUID } from "node:crypto";
import { app } from "electron";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type CallToolRequest,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  AgentLaunchManyArgsSchema,
  TerminalCloseManyArgsSchema,
  TerminalSendCommandManyArgsSchema,
  type BatchItemOutcome,
  type TerminalCloseManyArgs,
} from "../../../shared/types/mcpBatch.js";
import { resolveEffectiveActionDanger } from "../../../shared/utils/effectiveActionDanger.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { SendKeysArgsSchema } from "../../../shared/utils/terminalKeys.js";
import type { McpDispatchAuthorization } from "../../../shared/types/ipc/mcpServer.js";
import type { DispatchEnvelope } from "./shared.js";
import {
  MCP_ASSISTANT_SERVER_INSTRUCTIONS,
  MCP_SERVER_INSTRUCTIONS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  USER_REJECTED_CODE,
  EXECUTION_ERROR_CODE,
  SESSION_GONE,
  NO_FRONTEND_ATTACHED_CODE,
  INVALID_URL_CODE,
  RESOURCE_NOT_OWNED_CODE,
  buildToolError,
  withResolvedWorkspace,
  WORKSPACE_BINDING_CAPABILITY_KEY,
  type DispatchedWorkspaceRef,
  RELAY_CALL_ID_META_KEY,
} from "./shared.js";
import {
  INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import { isMcpHostRoutingEnabled } from "./driveTarget.js";
import {
  McpRouteBindingError,
  NoFrontendAttachedError,
  RelayDrivenElsewhereError,
  RendererBridgeUnavailableError,
  WorkspaceBindingError,
} from "./rendererBridge.js";
import { getExternalBaseManifest } from "./baseManifest.js";
import type { CallToolResultLike } from "./sessionDedup.js";
import {
  mayControlAssistants,
  mayRunProjectCommand,
  isPaneAutoConfirmed,
  buildStructuredContent,
  parseToolArguments,
  filterIntrospectionResultForSession,
  readSearchLimit,
  readListPaging,
  INTROSPECTION_TOOL_IDS,
  ACTIONS_LIST_TOOL_ID,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_TOOL_ID,
  ACTIONS_SEARCH_MAX_LIMIT,
} from "./tierAuth.js";
import { buildToolCallResult } from "./toolCallResult.js";
import { buildImageToolCallResult, isImageResultTool } from "./imageToolResult.js";
import { buildSurfaceManifest, MCP_SURFACE_TOOL_ID } from "./surfaceManifest.js";
import { viewlessStatusArgsAreAnswerable } from "./terminalStatus.js";
import { viewlessActionDanger } from "../viewless/viewlessActionCatalog.js";
import {
  AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL,
  createStepRequestKey,
  runLaunchInNewWorktree,
} from "./launchInNewWorktree.js";
import { parseLastMessageReadArgs } from "./lastMessageArgs.js";
import { withClosedPanelProcesses } from "./closedPanelProcesses.js";
import type { ClosedPanelExitTarget } from "./closedPanelExits.js";
import type { ActionError } from "../../../shared/types/actions.js";
import {
  DEFAULT_TERMINAL_EXIT_WAIT_MS,
  TerminalWaitForExitArgsSchema,
} from "../../../shared/types/terminalExitWait.js";
import {
  WORKTREE_DELETE_OWNED_TOOL,
  refuseWorktreeDeleteWhileRunning,
} from "./worktreeProcessGuard.js";
import {
  gitUnreadableRefusal,
  planWorktreeRetirement,
  refuseUnlessCleanAndPushed,
  retirementChangedSomething,
  retirementResult,
  retirementStopped,
  tearDownForRetirement,
  untouched,
  type RetirementAttribution,
  type RetirementPlan,
  type RetirementProgress,
} from "./worktreeRetirement.js";
import type { WorktreeGitObservation } from "./worktreeRetirementGit.js";
import { WorktreeRetireOwnedArgsSchema } from "../../../shared/types/worktreeRetirement.js";
import { LAST_MESSAGE_TEXT_MAX_BYTES } from "../../../shared/types/agentLastMessage.js";
import type { OwnedResourceRecord } from "./resourceOwnership.js";
import type { TerminalAdoptionRecord } from "./terminalAdoption.js";
import {
  NOTIFY_NOT_ELIGIBLE,
  NOTIFY_CLOSE_TOOLS,
  NOTIFY_KEY_TOOLS,
  NOTIFY_RESTART_TOOLS,
  NOTIFY_PROMPT_TOOLS,
  NOTIFY_SEND_TOOLS,
  NOTIFY_VALIDATION_ERROR,
  TERMINAL_NOTIFY_WHEN_IDLE_TOOL,
  TerminalNotifyError,
  auditCodeForNotifyRefusal,
  createNoticeHold,
  runNotifyWhenIdleTool,
  type NoticeHold,
  type OwnPane,
  type PendingNotify,
} from "./terminalNotify.js";
import {
  NOTIFY_REPLY_LINES_DEFAULT,
  NotifyReplyLinesSchema,
} from "../../../shared/types/terminalNotify.js";
import { REPLY_WAIT_DEFAULT_SECONDS, WaitSecondsSchema } from "../../../shared/types/replyWait.js";
import type { ReplyWait } from "./replyWaiter.js";
import {
  AGENT_READ_QUOTA_TOOL,
  ASSISTANT_CONTROL_TOOL_IDS,
  ASSISTANT_LIST_TOOL,
  ASSISTANT_START_TOOL,
  ASSISTANT_TARGET_REFUSALS,
  AssistantStartArgsSchema,
  WORKER_STEER_REFUSALS,
} from "../../../shared/types/assistantControl.js";
import { HOST_CALL_TOOL, HOST_CONTROL_TOOL_IDS } from "../../../shared/types/hostControl.js";
import { auditCodeForHostControlRefusal, runHostControlTool } from "./hostControlTools.js";
import {
  AssistantTargetError,
  type AssistantCaller,
  type AssistantTarget,
} from "../assistants/AssistantTerminalControl.js";
import type { WorkerSteerTarget } from "../assistants/GlobalWorkerSteer.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";
import { createSessionContext } from "./sessionContext.js";
import {
  createManifestResolver,
  lookupManifestEntry,
  registerListToolsHandler,
} from "./sessionToolDiscovery.js";
import { registerResourceHandlers } from "./sessionResources.js";
import { registerPromptHandlers } from "./sessionPrompts.js";
import { SESSION_GONE_MESSAGE, bindingGoneCode } from "./sessionRouteErrors.js";

export type {
  OwnedMainExecutors,
  SessionServerDeps,
  TerminalCloseContext,
} from "./sessionServerDepsContract.js";
export { isHandedBackUntouched } from "./sessionServerDepsContract.js";
export { cleanupResourceSubscriptions } from "./sessionResources.js";
import {
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,
  TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL,
  HELP_DISPLAY_IMAGE_TOOL,
  SKILLS_SEARCH_TOOL,
  SKILLS_LOAD_TOOL,
  PROJECT_RUN_CHECK_TOOL,
  PROJECT_RUN_COMMAND_TOOL,
  TERMINAL_GET_STATUS_TOOL,
  TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL,
  TERMINAL_WAIT_FOR_EXIT_TOOL,
  WORKTREE_RETIRE_OWNED_TOOL,
} from "./sessionToolIds.js";
import type { CallFacts, CallOutcome, CallerAdmission } from "./sessionCallFacts.js";
import {
  ASSISTANT_CONTROL_REFUSAL,
  PROJECT_RUN_COMMAND_REFUSAL,
  admitToolCall,
  buildCallIntrospectionSurface,
  chargeNativeGrant,
  refuseCallerOnlyTool,
  refuseConfirmGatedBoundCall,
} from "./sessionCallAdmission.js";
import {
  HAND_OVER_GRANT_PATH,
  HAND_OVER_HINT,
  OWNED_RESOURCE_TOOLS,
  SESSION_OWNERSHIP_NOTE,
  closedIdsInclude,
  createOwnershipAccess,
  dispatchOwnedResource,
  filterTerminalListToOwned,
  prepareTerminalListDispatch,
  noteClosedTerminals,
  readOwnedResourceId,
  recordOwnershipFromDispatch,
  type RendererOwnedResourceTool,
} from "./sessionCallOwnership.js";
import { lookupCallDedup, registerCallDedup } from "./sessionCallDedup.js";
import { createCallApprovals } from "./sessionCallApproval.js";
import { announceCallStarted, settleCall } from "./sessionCallSettlement.js";

/**
 * Backstop on the `actions.list` page walk. The registry is a few hundred
 * actions, so this only bounds a renderer that never stops reporting `hasMore`.
 */
const MAX_LIST_PAGE_WALK = 20;

/**
 * The tools whose execution never touches a renderer, and which are therefore
 * answerable for a workspace-bound session whose workspace has no live view
 * (#12316).
 *
 * These skip the bound confirm ceiling below, and only these. The ceiling
 * exists to stop a dispatch raising a dialog nobody is watching; it answers
 * that question by resolving the bound view's manifest, which is exactly the
 * thing an unreachable workspace cannot provide — so a tool that was never
 * going to reach a renderer failed on evidence it did not need. Each of these
 * has a short-circuit branch below whose own comment records that it is never
 * `danger: "confirm"`, and each of those branches returns unconditionally, so
 * no member can reach renderer dispatch with the ceiling unenforced. The
 * args-conditional elevations the ceiling also covers (`recipeId`,
 * `terminal.new`'s `command`/`cwd`) elevate a *dispatch*; a main-process
 * handler dispatches nothing, so a stray field of that name starts nothing.
 *
 * Kept beside the id constants the branches themselves match on, rather than
 * derived from tier metadata or MCP annotations: annotations are untrusted UX
 * hints, not an access-control boundary, and a second curated allowlist is the
 * drift this file has been bitten by before. `sessionServer.workspaceBound.test.ts` walks this
 * set and proves every member both answers viewlessly and never reaches
 * `dispatchAction`, so a member that stops being main-process-only fails there.
 *
 * `terminal.getStatus` is deliberately absent: it is a renderer action with a
 * reduced main-process fallback, handled separately below.
 */
export const VIEWLESS_MAIN_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,
  TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL,
  SKILLS_SEARCH_TOOL,
  SKILLS_LOAD_TOOL,
  MCP_SURFACE_TOOL_ID,
  PROJECT_RUN_CHECK_TOOL,
  PROJECT_RUN_COMMAND_TOOL,
  // Main-executed once its ownership check passes (#12479). It reads a file the
  // agent wrote and dispatches nothing, so a closed workspace is no reason to
  // refuse it.
  TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL,
  // Reads exits main kept and asks the pty-host to end a trash grace (#15728):
  // a closed pane's process outlives its view.
  TERMINAL_WAIT_FOR_EXIT_TOOL,
  // Terminal notices live in main and read the pty-host, so arming one needs
  // no project view.
  TERMINAL_NOTIFY_WHEN_IDLE_TOOL,
  // Assistants are found, started and quota read in main (#13496), from the
  // caller's own session, never a view.
  ASSISTANT_LIST_TOOL,
  ASSISTANT_START_TOOL,
  AGENT_READ_QUOTA_TOOL,
]);

/**
 * The agent messaging tools an assistant caller may point at another
 * assistant by the terminal id `assistant.list` gave it (#13496). They run in
 * main for such a target, whichever origin's twin was called: an assistant is
 * no grid pane, so no view's panels hold it.
 */
const ASSISTANT_TARGET_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendCommand",
  "terminal.sendCommandOwned",
  "terminal.interrupt",
  "terminal.interruptOwned",
  "terminal.sendKeys",
  "terminal.sendKeysOwned",
  "terminal.close",
  "terminal.closeOwned",
  TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL,
]);
/** Shown by the global Assistant through the steer's gate, on the owned reveal's own dispatch (#16096). */
const GLOBAL_REVEAL_TOOL = "terminal.revealOwned";
/**
 * The input tools the global Assistant may point at a worker it neither
 * launched nor was handed (#14551), and the reveal that shows the person that
 * worker's panel (#16096), and nothing else: closes, restarts and injections
 * keep the ownership ledger.
 */
const GLOBAL_STEER_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendCommandOwned",
  "terminal.sendKeysOwned",
  "terminal.interruptOwned",
  GLOBAL_REVEAL_TOOL,
]);
/** The closes whose answer carries what the host saw of each closed panel's process (#14474). */
const CLOSE_TOOLS: ReadonlySet<string> = new Set([
  "terminal.close",
  "terminal.closeOwned",
  "terminal.closeAll",
]);
const ASSISTANT_SEND_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendCommand",
  "terminal.sendCommandOwned",
]);
const ASSISTANT_KEYS_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendKeys",
  "terminal.sendKeysOwned",
]);
const ASSISTANT_INTERRUPT_TOOLS: ReadonlySet<string> = new Set([
  "terminal.interrupt",
  "terminal.interruptOwned",
]);

/**
 * The tools that watch or read named terminals, which already answer for an
 * assistant in the caller's project (#13496): only an assistant caller may
 * name one. The output and info reads go to the pty-host by id, past any
 * view's panels, so they are here too.
 */
const ASSISTANT_WATCH_TOOLS: ReadonlySet<string> = new Set([
  TERMINAL_GET_STATUS_TOOL,
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,
  TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL,
  TERMINAL_NOTIFY_WHEN_IDLE_TOOL,
  "terminal.getOutput",
  "terminal.info.get",
]);

/** Every terminal id a call's arguments name, by `terminalId` or `terminalIds`. */
function namedTerminalIds(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof record.terminalId === "string") ids.push(record.terminalId);
  if (Array.isArray(record.terminalIds)) {
    for (const id of record.terminalIds) if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * The launchers whose arguments can name an agent, and the one that can name
 * the new panel's id (#12407).
 */
const AGENT_LAUNCH_TOOL = "agent.launch";

/** Characters of quoted reply a batch may carry across all its items. */
const BATCH_REPLY_TEXT_BUDGET = 32_000;
const AGENT_NAMING_LAUNCH_TOOLS: ReadonlySet<string> = new Set([
  AGENT_LAUNCH_TOOL,
  AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL,
  "workflow.startWorkOnIssue",
]);

function isForceDelete(args: unknown): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  return (args as Record<string, unknown>).force === true;
}

function readStringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * A short, readable panel id for an MCP launch that named none (`claude-7f3a`).
 * A model repeats a terminal id in every send, notice and close, and a UUID
 * costs four times the tokens and gets mistyped: a live run closed the wrong id
 * after transposing two of its hex groups.
 */
export function shortAgentTerminalId(
  agentId: string | undefined,
  isInUse: (terminalId: string) => boolean
): string {
  const slug =
    (agentId ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "agent";
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = `${slug}-${randomBytes(attempt < 8 ? 2 : 4).toString("hex")}`;
    if (!isInUse(candidate)) return candidate;
  }
  return `${slug}-${randomUUID()}`;
}

interface BatchItem {
  target: string;
  tool: string;
  args: Record<string, unknown>;
}

interface BatchTool<T> {
  schema: {
    safeParse(
      value: unknown
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } };
  };
  expand: (args: T, rendererOwnedOrigin: boolean) => BatchItem[];
}

function batchTool<T>(tool: BatchTool<T>): BatchTool<unknown> {
  return tool as unknown as BatchTool<unknown>;
}

function notifyArgs(args: { notify?: boolean; handback?: boolean; replyLines?: number }) {
  return {
    ...(args.notify !== undefined ? { notify: args.notify } : {}),
    ...(args.handback !== undefined ? { handback: args.handback } : {}),
    ...(args.replyLines !== undefined ? { replyLines: args.replyLines } : {}),
  };
}

/**
 * The batch tools, and the single calls each item becomes. Items run in
 * order: launches of one agent kind must follow each other, and a caller
 * reading the results expects them in the order it gave.
 */
const BATCH_TOOLS: Record<string, BatchTool<unknown>> = {
  "agent.launchMany": batchTool({
    schema: AgentLaunchManyArgsSchema,
    expand: (args) =>
      [...new Set(args.agentIds)].map((agentId) => ({
        target: agentId,
        tool: AGENT_LAUNCH_TOOL,
        args: {
          agentId,
          prompt: args.prompt,
          name: `${args.name ?? "Agent"}: ${agentId}`,
          ...(args.worktreeId !== undefined ? { worktreeId: args.worktreeId } : {}),
          ...notifyArgs(args),
        },
      })),
  }),
  "terminal.sendCommandMany": batchTool({
    schema: TerminalSendCommandManyArgsSchema,
    // The assistant sends through the unscoped tool; every other session
    // through the owned one, which reaches only what it created or was handed.
    expand: (args, rendererOwnedOrigin) =>
      args.sends.map((send) => ({
        target: send.terminalId,
        tool: rendererOwnedOrigin ? "terminal.sendCommand" : "terminal.sendCommandOwned",
        args: {
          terminalId: send.terminalId,
          command: send.command,
          ...(send.generation !== undefined ? { generation: send.generation } : {}),
          ...notifyArgs(args),
        },
      })),
  }),
  "terminal.closeMany": batchTool({
    schema: TerminalCloseManyArgsSchema,
    expand: (args, rendererOwnedOrigin) =>
      [...new Set(args.terminalIds)].map((terminalId) => ({
        target: terminalId,
        tool: rendererOwnedOrigin ? "terminal.close" : "terminal.closeOwned",
        args: { terminalId },
      })),
  }),
};

/**
 * Tie a waiter to the terminal and submission a dispatch reported, or settle
 * it at once when the send or launch did not happen. Returns the terminal it
 * bound to; undefined when the dispatch failed and the wait was cancelled.
 */
function bindWait(result: CallToolResult, wait: ReplyWait): string | undefined {
  const parsed = resultValue(result);
  const value =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const terminalId = typeof value?.terminalId === "string" ? value.terminalId : undefined;
  const failed =
    result.isError === true ||
    terminalId === undefined ||
    value?.launched === false ||
    (value?.spawnStatus !== undefined && value.spawnStatus !== null);
  if (failed) {
    wait.cancel();
    return undefined;
  }
  const token = typeof value?.submissionToken === "string" ? value.submissionToken : undefined;
  wait.bind(terminalId, token);
  return terminalId;
}

/** How a call's reply wait ended, as its held notice needs to know. */
type ReleaseNotice = (answered: boolean, stoppedWithoutMarker: boolean) => void;

/**
 * Settle a call's held notice by how its reply wait ended: an answered wait
 * already told the caller, and one that ran out leaves the notice as the word
 * of the end. A stop with no marker can still be followed by one.
 */
function releaseNoticeAfter(wait: ReplyWait, release: ReleaseNotice): void {
  void wait.promise.then((reply) =>
    release(
      reply.outcome !== "timeout",
      reply.outcome === "settled" && reply.handback === undefined
    )
  );
}

/** A send's or launch's result with the reply it waited for. */
async function attachReply(
  result: CallToolResult,
  wait: ReplyWait,
  releaseNotice?: ReleaseNotice
): Promise<CallToolResult> {
  if (releaseNotice !== undefined) releaseNoticeAfter(wait, releaseNotice);
  // A failed dispatch is returned as it came, even when its wait had already
  // ended: rebuilding it around a reply would drop `isError`.
  if (bindWait(result, wait) === undefined) return result;
  const reply = await wait.promise;
  if (reply.terminalId === "") return result;
  const base = resultValue(result);
  const value = {
    ...(base !== null && typeof base === "object" ? (base as Record<string, unknown>) : {}),
    reply,
  };
  return buildToolCallResult(value, {
    structuredContent: value as unknown as Record<string, unknown>,
  }) as CallToolResult;
}

/** A call's value: its structured content, else its JSON text, else the text. */
function resultValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = result.content?.[0];
  const text = first !== undefined && first.type === "text" ? first.text : undefined;
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** One item's result, as structured content when the call carried it. */
function batchItemOutcome(target: string, result: CallToolResult): BatchItemOutcome {
  const value = resultValue(result);
  return result.isError === true
    ? { target, ok: false, error: value }
    : { target, ok: true, result: value };
}

/**
 * Read a send's or launch's `notify` flag, and take it off the arguments a
 * send's renderer receives. Whose prompt to type into is main-process state the
 * renderer never sees, so the flag is acted on here. A launch keeps it: only
 * the renderer knows the effective agent registry, so `agent.launch` is what
 * refuses `notify` for a shell or panel, and that refusal cancels the notice.
 * Only an actual boolean is read; anything else is left for the renderer's own
 * schema validation to reject; `replyLines` goes with it. The owned send
 * rebuilds its arguments from `forwardArgs`, which never names the flag.
 */
function prepareNotifyDispatch(
  actionId: string,
  args: unknown
): {
  dispatchArgs: unknown;
  notify: boolean;
  replyLines?: number;
  waitForReply: boolean;
  waitSeconds?: number;
} {
  if (
    !NOTIFY_SEND_TOOLS.has(actionId) ||
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    return { dispatchArgs: args, notify: false, waitForReply: false };
  }
  const { notify, replyLines, waitForReply, waitSeconds, ...rest } = args as Record<
    string,
    unknown
  >;
  // A malformed argument stays in the forwarded arguments so the renderer's
  // schema rejects the call; a well-formed one is main's and goes no further.
  const parsedLines = NotifyReplyLinesSchema.safeParse(replyLines);
  const parsedWait = WaitSecondsSchema.safeParse(waitSeconds);
  const sendArgs: Record<string, unknown> = { ...rest };
  if (notify !== undefined && typeof notify !== "boolean") sendArgs.notify = notify;
  if (!parsedLines.success) sendArgs.replyLines = replyLines;
  if (waitForReply !== undefined && typeof waitForReply !== "boolean") {
    sendArgs.waitForReply = waitForReply;
  }
  if (!parsedWait.success) sendArgs.waitSeconds = waitSeconds;
  return {
    dispatchArgs: actionId === AGENT_LAUNCH_TOOL ? args : sendArgs,
    notify: notify === true,
    ...(parsedLines.success && parsedLines.data !== undefined
      ? { replyLines: parsedLines.data }
      : {}),
    waitForReply: waitForReply === true && !NOTIFY_KEY_TOOLS.has(actionId),
    ...(parsedWait.success && parsedWait.data !== undefined
      ? { waitSeconds: parsedWait.data }
      : {}),
  };
}

/**
 * Validate a `help.displayImage` URL (#9828). Only `https://daintree.org` and
 * its subdomains are accepted; `data:`/`blob:`/other-host URLs are rejected so
 * the assistant can't smuggle arbitrary content into the panel. The explicit
 * `data:`/`blob:` pre-check gives a clearer message than the generic
 * protocol failure (`new URL("data:...")` parses with `protocol === "data:"`).
 */
export function validateDisplayImageUrl(
  url: string
): { valid: true } | { valid: false; message: string } {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return {
      valid: false,
      message: "data: and blob: URIs are not permitted; provide an https://daintree.org URL.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, message: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      message: `Only https: URLs are accepted; got '${parsed.protocol}'.`,
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "daintree.org" && !hostname.endsWith(".daintree.org")) {
    return {
      valid: false,
      message: `URL host must be daintree.org (or a subdomain); got '${parsed.hostname}'.`,
    };
  }
  // Reject non-default ports: the CSP `img-src https://daintree.org` matches
  // port 443 only, so a non-standard port would pass validation here but get
  // blocked at render time — a success/render mismatch the model can't recover
  // from. `URL.port` is "" when the default 443 was used.
  if (parsed.port !== "" && parsed.port !== "443") {
    return {
      valid: false,
      message: `Only the default https port is accepted; got port '${parsed.port}'.`,
    };
  }
  return { valid: true };
}

/**
 * An assistant tool's or target's refusal as the audit records it: its own
 * code goes to the caller, the shared vocabulary to the log.
 */
function auditCodeForAssistantRefusal(
  code: string
): import("../../../shared/types/actions.js").ActionErrorCode {
  switch (code) {
    case "VALIDATION_ERROR":
      return "VALIDATION_ERROR";
    case EXECUTION_ERROR_CODE:
      return "EXECUTION_ERROR";
    case ASSISTANT_TARGET_REFUSALS.notFound:
    case WORKER_STEER_REFUSALS.notFound:
      return "NOT_FOUND";
    default:
      return "RESTRICTED";
  }
}

/** A relayed write refused at its last check, just before its side effect (#13493). */
class RelayWriteRefused extends Error {
  constructor(readonly refusal: { code: string; message: string }) {
    super(refusal.message);
    this.name = "RelayWriteRefused";
  }
}

export function createSessionServer(sessionId: string, deps: SessionServerDeps): Server {
  const {
    sessionStore,
    requestManifest,
    dispatchAction,
    handleWaitUntilIdle: waitUntilIdle,
    handleWaitUntilIdleBatch: waitUntilIdleBatch,
    handleSkillsSearch,
    handleSkillsLoad,
    handleProjectRunCheck,
    handleProjectRunCommand,
    handleTerminalGetStatusViewless,
    appendAuditRecord: appendSessionAuditRecord,
    getCachedManifest,
    notifyTierMismatch,
    recordDenial,
    notifySessionRevoked,
    clearDenialState,
    getCurrentTurnId,
    readAssistantConfirmationsSkipped,
    notifyToolCallStarted,
    notifyToolCallSettled,
    notifyDisplayImage,
    workspaceBinding,
    terminalNotify,
    hostControl,
    assistantControl,
    replyWaiter,
    resolveOwnPane,
    requestApproval,
    requestCloseApproval,
    readTerminalCloseContext,
    readClosedPanelProcess,
    waitForClosedPanelExits,
  } = deps;

  const session = createSessionContext(sessionId, deps);
  const { sessionSurface, isGlobalSession, hostCallOffered, assistantCallerNow } = session;

  const server = new Server(
    { name: "Daintree", version: app.getVersion() },
    {
      capabilities: {
        // `listChanged: true` is required for clients to process the
        // `notifications/tools/list_changed` we send when a session's tier
        // elevates or decays (#8462). Must be declared at construction —
        // the SDK rejects post-connect capability registration in ^1.20+.
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: false },
        prompts: {},
        // Echo the resolved workspace binding so a client can verify it before
        // issuing a mutation (#11789). `experimental` is the SDK's sanctioned
        // slot for server-defined capabilities and the SDK folds it into the
        // initialize result verbatim — which is why this is declared here
        // rather than by registering our own `InitializeRequestSchema` handler,
        // a second handler would shadow the SDK's `_oninitialize` and lose the
        // `_clientCapabilities` capture that elicitation negotiation reads.
        ...(workspaceBinding
          ? {
              experimental: {
                [WORKSPACE_BINDING_CAPABILITY_KEY]: { ...workspaceBinding },
              },
            }
          : {}),
      },
      // The SDK folds this into the `initialize` result on its own, so no
      // handler of ours is involved (#11541). Passed at construction because
      // that result is built once, at the handshake, and instructions have no
      // update notification — there is no later seam to set them from.
      // Daintree's own assistants carry these rules in their own prompts.
      instructions: sessionStore.isRendererOwnedOrigin(sessionId)
        ? MCP_ASSISTANT_SERVER_INSTRUCTIONS
        : MCP_SERVER_INSTRUCTIONS,
    }
  );

  const resolveManifest = createManifestResolver(deps);
  registerListToolsHandler(server, session, deps, resolveManifest);

  // Named so a batch tool can run each item through this same gate.
  const handleCallTool = async (
    request: CallToolRequest,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    // A batch item whose reply the batch waits for: its notice holds on this.
    // `closeApproved` marks a close the batch already put to the user (#12881),
    // so the item does not ask a second time; `confirmationsSkipped` carries the
    // batch's skip decision so every item runs under the one the batch read.
    // Never reachable from a client.
    batchItem?: {
      noticeHold?: NoticeHold;
      closeApproved?: boolean;
      confirmationsSkipped?: boolean;
      relayCallId?: string;
    }
  ): Promise<CallToolResult> => {
    const actionId = request.params.name;
    const { args, requestKey } = parseToolArguments(request.params.arguments);
    // A relayed call's callId from its Shell (#13493), on every record of it and of its items.
    const relayMeta = request.params._meta?.[RELAY_CALL_ID_META_KEY];
    const relayCallId =
      batchItem?.relayCallId ??
      (deps.relay !== undefined && typeof relayMeta === "string" && relayMeta.length <= 256
        ? relayMeta
        : undefined);
    const appendAuditRecord: SessionServerDeps["appendAuditRecord"] = (input) =>
      appendSessionAuditRecord(relayCallId !== undefined ? { ...input, relayCallId } : input);
    // The caller's pane for its notices. A relayed call's go back to its
    // Shell, pinned there to the run that made this call (#13500).
    const ownPane = (): OwnPane | null => {
      const pane = resolveOwnPane?.() ?? null;
      if (pane?.relay === undefined || relayCallId === undefined) return pane;
      return { ...pane, relay: { ...pane.relay, callId: relayCallId } };
    };
    const startedAt = Date.now();
    const tier = sessionStore.getTier(sessionId);
    // Gate 0 (#11799): no live session, no authorization. The SDK's own
    // transport await — body parse and JSON-RPC routing — sits between "the
    // request arrived on a live session" and this handler, so an idle-timer
    // expiry or an abuse trip on a concurrent call can revoke the session in
    // between. Refusing here, before the tier gate, keeps a revoked external
    // bearer off the core surface its own allowlist withholds.
    //
    // Returns before anything observable happens: no audit record (there is no
    // honest tier to record it under), no denial counter, no tier-mismatch
    // banner, no grant lookup, no dedup entry, and no dispatch.
    if (tier === null) {
      return buildToolError({ code: SESSION_GONE, message: SESSION_GONE_MESSAGE });
    }
    // The global assistant (#14159) names no project, so it runs only its root
    // tools here (#14161), whichever handler would answer: a main-side tool
    // that reads a terminal by id would otherwise reach any project's. Every
    // project is reached through `host.call`, admitted by its host.
    if (isGlobalSession() && !GLOBAL_ASSISTANT_TOOL_IDS.has(actionId)) {
      return buildToolError({
        code: NO_FRONTEND_ATTACHED_CODE,
        message: `The global assistant has no project of its own, so it reaches projects only through ${HOST_CALL_TOOL}. Nothing was run.`,
      });
    }
    // Snapshot the turn id once, at dispatch start, before any guard or await
    // can yield to an active→passive FSM transition that would clear it (#10067).
    // Every consumer below — the started/settled strip events and all audit
    // records — receives this same value so one tool call can never split
    // across two turn groupings in the Assistant panel.
    const capturedTurnId: string | null = getCurrentTurnId?.() ?? null;
    // Asked of the ORIGIN, never inferred from the tier: an unrecognised bearer
    // resolves to `core` while its origin still defaults to `external`,
    // and an agent pane's bearer holds a ladder tier with an `external` origin.
    // Captured once so discovery, the tier gate and `mcp.surface` all describe
    // the same session (#12407).
    const rendererOwnedOrigin = sessionStore.isRendererOwnedOrigin(sessionId);
    const facts: CallFacts = {
      sessionId,
      actionId,
      args,
      requestKey,
      startedAt,
      tier,
      capturedTurnId,
      rendererOwnedOrigin,
    };
    // Who may run the command runner (#13495, #13501), asked once so its
    // listing, discovery and admission below agree.
    const commandRunnerCaller = mayRunProjectCommand(tier, {
      rendererOwnedOrigin,
      relay: sessionSurface.relay === true,
    });
    // The assistant this call comes from, when it is one (#13496), read once so
    // the assistant tools' listing, discovery and admission below agree, and
    // so every assistant target this call names is resolved for the same one.
    const assistantCaller = tier === "external" ? null : assistantCallerNow();
    const assistantControlCaller = mayControlAssistants(tier, {
      assistantCaller: assistantCaller !== null,
    });
    const callers: CallerAdmission = { commandRunnerCaller, assistantControlCaller };
    // A change main makes itself for an assistant answers to the drive rule
    // (#13493): a relayed one as its Shell's view would, a host's own
    // assistant with no view as nobody's. Null while it may go ahead.
    const assistantWriteRefusal = (projectId: string): { code: string; message: string } | null =>
      deps.relay !== undefined
        ? deps.relay.refuseWrite(projectId)
        : (deps.refuseWrite?.(projectId) ?? null);
    // Ending the trash grace of panels this caller closed is a change main
    // makes itself, so it answers to the drive rule for each project they
    // were closed in (#13493, #15728): one principal can hold sessions in
    // several. Null while it may go ahead.
    const graceWriteRefusal = (
      workspaceIds: Iterable<string | undefined>
    ): { code: string; message: string } | null => {
      const refuseWrite =
        deps.relay !== undefined
          ? (projectId: string | undefined) => deps.relay!.refuseWrite(projectId)
          : deps.refuseWrite;
      if (refuseWrite === undefined) return null;
      for (const workspaceId of workspaceIds) {
        const refusal = refuseWrite(workspaceId);
        if (refusal) return refusal;
      }
      return null;
    };
    // One agent-messaging call against an assistant this call named (#13496):
    // a send, an interrupt, a close or a read, with only what that tool takes.
    const runAssistantTarget = async (
      target: AssistantTarget,
      caller: AssistantCaller
    ): Promise<unknown> => {
      const control = assistantControl!;
      const record =
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      if (actionId === TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL) {
        const read = parseLastMessageReadArgs(args);
        if (!read.ok) throw new AssistantTargetError("VALIDATION_ERROR", read.message);
        if (read.options.cursor !== undefined || (read.options.messageIndex ?? 0) > 0) {
          throw new AssistantTargetError(
            "VALIDATION_ERROR",
            "An assistant's reply is read off its screen, latest only: it takes `maxBytes` alone."
          );
        }
        return control.readReply(target, read.options.maxBytes ?? LAST_MESSAGE_TEXT_MAX_BYTES);
      }
      const refusal = assistantWriteRefusal(target.projectId);
      if (refusal) throw new AssistantTargetError(refusal.code, refusal.message);
      if (ASSISTANT_SEND_TOOLS.has(actionId)) {
        const command = typeof record.command === "string" ? record.command : "";
        if (command.trim().length === 0) {
          throw new AssistantTargetError("VALIDATION_ERROR", "A send needs a non-empty `command`.");
        }
        const generation =
          typeof record.generation === "number" && Number.isInteger(record.generation)
            ? record.generation
            : undefined;
        return control.submit(caller, target, {
          command,
          generation,
          handback: record.handback === true,
        });
      }
      if (ASSISTANT_KEYS_TOOLS.has(actionId)) {
        const parsed = SendKeysArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new AssistantTargetError(
            "VALIDATION_ERROR",
            `Pressing keys needs \`keys\` or \`choose\`: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`
          );
        }
        return control.sendKeys(caller, target, {
          keys: parsed.data.keys,
          choose: parsed.data.choose,
          generation: parsed.data.generation,
        });
      }
      if (ASSISTANT_INTERRUPT_TOOLS.has(actionId)) return control.interrupt(target);
      return control.close(caller, target);
    };
    const callArgs =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    // The run a global Assistant's call names (#14551, #16096), in the
    // project this session is bound to and no other.
    const globalSteerTarget = (terminalId: string): WorkerSteerTarget => {
      const projectId = sessionStore.sessionWorkspaceMap.get(sessionId);
      if (projectId === undefined) {
        throw new AssistantTargetError(
          WORKER_STEER_REFUSALS.notFound,
          "This call isn't bound to a project, so it can't reach a terminal. Nothing was done."
        );
      }
      const generation =
        typeof callArgs.generation === "number" &&
        Number.isInteger(callArgs.generation) &&
        callArgs.generation >= 0
          ? callArgs.generation
          : undefined;
      return {
        projectId,
        terminalId,
        generation,
        authorize: () => {
          if (sessionStore.getTier(sessionId) === null) {
            throw new AssistantTargetError(SESSION_GONE, SESSION_GONE_MESSAGE);
          }
          const refusal = assistantWriteRefusal(projectId);
          if (refusal) throw new AssistantTargetError(refusal.code, refusal.message);
        },
      };
    };
    // The global Assistant steering a worker it didn't launch (#14551). Every
    // argument the delegate would have validated is validated here, since
    // none reaches it.
    const runGlobalSteer = async (terminalId: string): Promise<unknown> => {
      const steer = deps.globalSteer!;
      const target = globalSteerTarget(terminalId);
      if (actionId === "terminal.sendCommandOwned") {
        const command = typeof callArgs.command === "string" ? callArgs.command : "";
        if (command.trim().length === 0) {
          throw new AssistantTargetError("VALIDATION_ERROR", "A send needs a non-empty `command`.");
        }
        return steer.prompt(target, {
          command,
          handback: callArgs.handback === true,
          machineName: deps.relay?.shellName ?? "another machine",
        });
      }
      if (actionId === "terminal.sendKeysOwned") {
        const parsed = SendKeysArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new AssistantTargetError(
            "VALIDATION_ERROR",
            `Invalid keys: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Nothing was pressed.`
          );
        }
        return steer.keys(target, {
          ...(parsed.data.keys !== undefined ? { keys: parsed.data.keys } : {}),
          ...(parsed.data.choose !== undefined ? { choose: parsed.data.choose } : {}),
        });
      }
      return steer.interrupt(target);
    };
    // Daintree's own assistant only (#12874): not agent panes, not api-key
    // clients. Read live per call, and a
    // failed read keeps the dialog. A batch item inherits its batch's answer.
    let confirmationsSkipped = false;
    if (batchItem?.confirmationsSkipped !== undefined) {
      confirmationsSkipped = batchItem.confirmationsSkipped;
    } else if (sessionStore.getOrigin(sessionId) === "help") {
      try {
        confirmationsSkipped = readAssistantConfirmationsSkipped?.() === true;
      } catch (err) {
        console.error("[MCP] Failed to read the assistant confirmation preference:", err);
      }
    }
    // Whose ownership records this call reads and writes (#12487): the
    // bearer's principal for a pane session, else the session itself. Captured
    // at admission so the ownership gate, an `owned` listing and the
    // post-dispatch bookkeeping all consult one owner — and so a creation that
    // completes after the transport dropped still lands with the principal the
    // call was authorized under, where the pane's next session finds it.
    const ownershipOwner = sessionStore.resourceOwnership.ownerOf(sessionId);
    // An api-key client (#12987): no bearer bound it, so its records are held
    // by the session and die with it. Asked of the owner, not the origin — a
    // pane's session has an `external` origin too.
    const sessionScopedOwner = !sessionStore.resourceOwnership.isPrincipalOwner(ownershipOwner);
    const boundWorkspaceId = sessionStore.sessionWorkspaceMap.get(sessionId);
    const { ownedRecordFor, adoptedRecordFor, drivesTerminal, closeNeedsApproval } =
      createOwnershipAccess(
        sessionStore,
        ownershipOwner,
        boundWorkspaceId,
        readTerminalCloseContext
      );

    const searchLimit = actionId === ACTIONS_SEARCH_TOOL_ID ? readSearchLimit(args) : null;
    const listPaging = actionId === ACTIONS_LIST_TOOL_ID ? readListPaging(args) : null;
    // Discovery must mirror dispatch authority (#11525). The introspection
    // tools enumerate the action registry from the renderer, which has no idea
    // which session called it, so main computes the effective surface here and
    // narrows the result on the way back.
    //
    // "Effective" is the static tier allowlist widened by every live grant —
    // the same three sources the dispatch gate below consults. Native
    // automation grants (#10648) matter most: they are issued up front with an
    // explicit `allowedTools` set, so ignoring them would leave an agent unable
    // to find the very tools it was just approved for. Reads go through the
    // non-evicting `getLive*` snapshots; `grantCache.check` / `peekNativeGrant`
    // would delete expired entries and push spurious `grant.expired` lifecycle
    // events on every discovery call.
    const introspectionSurface = INTROSPECTION_TOOL_IDS.has(actionId)
      ? buildCallIntrospectionSurface(
          sessionStore.grantCache,
          sessionSurface,
          hostCallOffered,
          facts,
          {
            ...callers,
            confirmationsSkipped,
            searchLimit,
            listPaging,
          }
        )
      : null;
    // `actions.search` ranks and slices in the renderer, before main can see
    // tier. Over-fetching the schema's maximum page makes that slice the
    // complete match set for any query matching at most that many actions, so
    // filtering it yields an exact count and a full page instead of a starved
    // one. Only the forwarded copy is widened — `args` still feeds the audit
    // record, which must report what the caller actually asked for. A `limit`
    // the tool contract forbids yields a null `searchLimit` and is left alone,
    // so the renderer's own validation still rejects it rather than having the
    // over-fetch quietly rewrite it into a legal request.
    const searchDispatchArgs =
      searchLimit !== null && args && typeof args === "object" && !Array.isArray(args)
        ? { ...(args as Record<string, unknown>), limit: ACTIONS_SEARCH_MAX_LIMIT }
        : args;
    // `terminal.list`'s `owned` filter is decided here and taken off the
    // forwarded copy in the same call (#12308) — see
    // `prepareTerminalListDispatch` for why those two are inseparable. Chained
    // off the search rewrite above rather than folded into it: the two tools
    // are disjoint, and one rewrite that handled both would have to be re-read
    // whenever either changed. `args` stays untouched for the audit record.
    const { dispatchArgs: listDispatchArgs, ownedOnly } = prepareTerminalListDispatch(
      actionId,
      searchDispatchArgs
    );
    // A send's or launch's `notify` is decided here and taken off the forwarded
    // copy the same way; see `prepareNotifyDispatch`.
    const { dispatchArgs, notify, replyLines, waitForReply, waitSeconds } = prepareNotifyDispatch(
      actionId,
      listDispatchArgs
    );
    // Armed inside the dispatch, once the owned target is resolved, and read
    // after it: the reply joins whatever result the dispatch built.
    let replyWait: ReplyWait | undefined;
    // The follow-up a `notify: true` call set up before dispatch. Completed
    // with the envelope once the action returns, and cancelled by the shared
    // `finally` on every other way out, so a refused or failed call never
    // leaves a notice behind.
    let pendingNotify: PendingNotify | undefined;
    // A call with `notify` and `waitForReply` both holds its notice while the
    // wait runs, since the wait answers the caller itself when it can; this
    // settles it once the wait ends.
    let releaseNotice: ReleaseNotice | undefined;
    // A restart's hold on the pane's own notice for its target (#14369), ended
    // by the dispatch's outcome or, on any other way out, released unchanged.
    let settleRestartHold: ((replaced: boolean) => void) | undefined;

    // Set once the ownership gate inside the IIFE has cleared, and read by the
    // delegated dispatch and the post-cleanup release. Undefined for every
    // other tool and for a refused call, so neither of those paths can
    // accidentally rewrite an action id or drop an ownership record (#11909).
    const ownedResource = OWNED_RESOURCE_TOOLS[actionId];
    let ownedResourceId: string | undefined;
    // A worker the global Assistant shows the person without owning it
    // (#16096), set by the gate; it is `ownedResourceId` too, so the answer
    // names it, but no ledger record or hand-over admitted it.
    let globalRevealTerminalId: string | undefined;
    // The record the gate accepted. A release drops only this record, so a
    // cleanup that completes after another session on the same bearer
    // recorded a new resource under the id cannot take the new one with it.
    let ownedResourceRecord: OwnedResourceRecord | undefined;
    // The hand-over the gate admitted the call on, when it was one rather than
    // a creation (#12490). Checked again just before dispatch, because the user
    // can take the terminal back while the call waits on a manifest — and
    // checked by identity, so a take-back followed by a fresh hand-over is not
    // mistaken for the consent this call was admitted under. The thaw of a
    // frozen view inside the bridge still follows; a call caught there is no
    // different from one sent the moment before the take-back.
    let admittedAdoption: TerminalAdoptionRecord | undefined;
    // A retirement the preflight cleared (#15737): what it closes and waits
    // for, and what git saw, carried to the teardown just before the delete.
    // `progress` is set once that teardown finished, and only then is the
    // delete's answer read as the retirement's.
    let retirement:
      | {
          worktreeId: string;
          plan: RetirementPlan;
          timeoutMs: number;
          git: WorktreeGitObservation & { headOid: string };
          progress?: RetirementProgress;
        }
      | undefined;

    const dispatchOwnedResourceAction = (
      entry: RendererOwnedResourceTool,
      resourceId: string
    ): Promise<{ envelope: DispatchEnvelope; raised: boolean }> =>
      dispatchOwnedResource(
        {
          sessionId,
          actionId,
          args,
          sessionStore,
          ownershipOwner,
          adoptedRecordFor,
          admittedAdoption,
          dispatchToRenderer,
          dispatchConfirmed,
          revealOwnedRun: deps.revealOwnedRun,
        },
        entry,
        resourceId
      );

    const recordDispatchOwnership = (envelope: DispatchEnvelope): void =>
      recordOwnershipFromDispatch(
        { sessionId, actionId, sessionStore, ownershipOwner },
        { ownedResource, ownedResourceId, ownedResourceRecord },
        envelope
      );

    const admission = admitToolCall(
      { sessionStore, notifyTierMismatch, recordDenial, clearDenialState, notifySessionRevoked },
      sessionSurface,
      facts,
      callers,
      appendAuditRecord
    );
    if (admission.kind === "return") return admission.result;
    const { paneApproval, grantIssuedAt, authorizedWithoutNativeGrant, approvalRequired } =
      admission.value;
    let { nativeGrantId } = admission.value;

    // The workspace to answer `terminal.getStatus` for from the pty-host, set
    // when the bound workspace has no live view (#12316). Read off the binding
    // failure the ceiling below already resolved — the exact workspace routing
    // itself tried to reach — so a caller argument can never redirect the read.
    let viewlessStatusWorkspaceId: string | undefined;

    // Confirm-gated tools are unreachable for a workspace-bound external
    // session, so refuse them here — after tier/grant admission, but before a
    // native grant use is charged, before dedup can cache an answer, and long
    // before anything reaches a renderer (#11789).
    //
    // Placed after the tier gate so a tool that is simply outside the surface
    // still reports TIER_NOT_PERMITTED, which is the truer answer. Placed
    // before everything else because this is a hard ceiling: a live per-tool or
    // native grant widens dispatch past the tier floor, and must not widen past
    // this one — the dialog those grants would bypass is the same dialog nobody
    // is watching.
    //
    // Skipped entirely for {@link VIEWLESS_MAIN_PROCESS_TOOLS}: the ceiling is a
    // question about renderer dispatch, and those tools never reach one, so
    // resolving the bound view's manifest to answer it made a workspace's view
    // residency a precondition for calls that never needed a view (#12316).
    if (
      sessionSurface.workspaceBound &&
      tier === "external" &&
      !VIEWLESS_MAIN_PROCESS_TOOLS.has(actionId)
    ) {
      let boundManifest: import("../../../shared/types/actions.js").ActionManifestEntry[];
      try {
        boundManifest = getCachedManifest() ?? (await requestManifest());
      } catch (err) {
        // One exception to failing closed, and it is not a confirm decision:
        // `terminal.getStatus` has a read-only main-process fallback that reads
        // the pty-host directly (#12316). Taken only when the workspace simply
        // has no view — an `ambiguous` binding is a conflict the user must
        // resolve, and a destroyed pin is not a route that comes back — and only
        // when the call named its terminals, since the fleet path filters on
        // `location`, which has no pty-host meaning. The fallback is `danger:
        // "safe"`, dispatches nothing, and so raises no dialog: the ceiling has
        // nothing to decide about it.
        if (
          actionId === TERMINAL_GET_STATUS_TOOL &&
          err instanceof WorkspaceBindingError &&
          err.reason === "not-found" &&
          viewlessStatusArgsAreAnswerable(args)
        ) {
          viewlessStatusWorkspaceId = err.workspaceId;
          boundManifest = [];
        } else if (
          err instanceof NoFrontendAttachedError &&
          getExternalBaseManifest().some((entry) => entry.id === actionId)
        ) {
          // Nothing is attached to the workspace, so no renderer can be asked:
          // the dispatch below either runs the action in main or refuses it as
          // needing a frontend. The ceiling still has a truthful answer for a
          // built-in tool, because the host's base surface is generated from
          // the same action registry, and it is what keeps a confirm-gated call
          // refused here rather than run by main unattended. A tool the base
          // surface does not describe — a plugin's — keeps failing closed below:
          // a view that opened before its dispatch could raise its dialog.
          boundManifest = getExternalBaseManifest();
        } else {
          // Fail closed. Proceeding on an unresolved manifest would erase the
          // only evidence that this action needs confirmation, turning a refusal
          // into an unattended dispatch. Audited as a throw, matching how the
          // post-dispatch binding failure below records the same class of error.
          try {
            appendAuditRecord({
              toolId: actionId,
              sessionId,
              tier,
              args,
              durationMs: Date.now() - startedAt,
              startedAt,
              outcome: { kind: "throw", error: err },
              capturedTurnId,
            });
          } catch (auditErr) {
            console.error("[MCP] Failed to append audit record:", auditErr);
          }
          if (err instanceof McpRouteBindingError) {
            // Deliberately NOT answered from the host base surface, unlike
            // `tools/list` (#12082). Discovery describes what exists; this gate
            // decides whether a specific call runs unattended, and the host
            // catalog is not evidence about the bound view. Fail closed, and say
            // so retriably when the route can come back.
            //
            // The one thing added is a way out: a `terminal.getStatus` that named
            // no terminals is refused here, but the same call *with* explicit
            // `terminalIds` is answerable from the pty-host without a view
            // (#12316). Say so, rather than leaving a poller to retry the shape
            // that cannot work.
            // Scoped to `not-found`, the only reason the fallback takes.
            // Telling a caller whose workspace is open in two views to retry
            // with ids would be advice that cannot work.
            const viewlessHint =
              actionId === TERMINAL_GET_STATUS_TOOL &&
              err instanceof WorkspaceBindingError &&
              err.reason === "not-found"
                ? ` Status for specific terminals can still be read while the workspace is closed — call '${actionId}' again with an explicit 'terminalIds' array.`
                : "";
            return buildToolError({
              code: bindingGoneCode(err),
              message: `${err.message}${viewlessHint}`,
              retriable: err.retriable,
            });
          }
          return buildToolError({
            code: EXECUTION_ERROR_CODE,
            message: formatErrorMessage(
              err,
              `Could not resolve the action surface for workspace-bound tool '${actionId}'`
            ),
          });
        }
      }

      const boundRefusal = refuseConfirmGatedBoundCall(
        facts,
        workspaceBinding,
        sessionSurface,
        boundManifest,
        viewlessStatusWorkspaceId,
        introspectionSurface,
        appendAuditRecord
      );
      if (boundRefusal !== undefined) return boundRefusal;
    }

    const callerRefusal = refuseCallerOnlyTool(facts, callers, appendAuditRecord);
    if (callerRefusal !== undefined) return callerRefusal;

    const charge = chargeNativeGrant(
      sessionStore.grantCache,
      facts,
      nativeGrantId,
      authorizedWithoutNativeGrant
    );
    if (charge.kind === "return") return charge.result;
    nativeGrantId = charge.value;

    const dedup = lookupCallDedup(sessionStore, facts, appendAuditRecord);
    if (dedup.kind === "return") return dedup.result;
    if (dedup.kind === "await") return await dedup.promise;
    const { dedupKey, argsHash } = dedup.value;

    let outcome: CallOutcome | undefined;
    let confirmationDecision:
      import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision | undefined;
    // What pre-authorizes this dispatch's `danger: "confirm"` modal, if
    // anything. A native automation grant is an explicit user approval of the
    // tool's scope, so it authorizes the dispatch without surfacing a per-call
    // modal — exactly as if the user had just approved it. For an agent pane the
    // project's "Skip confirmations" setting at `full` does the same (#12876),
    // as does a session approval the user gave from the dialog (#12692) — but
    // neither for a tool whose dialog is also where the user picks its targets.
    // No tier pre-authorizes on its own. An above-tier approval, granted below,
    // sets this too. The D3 typed-name gate is outside all of them: the bridge
    // re-derives it for any preconfirmed force delete (#12115).
    let dispatchAuthorization: McpDispatchAuthorization | undefined =
      nativeGrantId !== undefined
        ? "native-grant"
        : isPaneAutoConfirmed(
              tier,
              actionId,
              paneApproval,
              sessionSurface.paneSkipConfirmations === true
            )
          ? "project-setting"
          : paneApproval && grantIssuedAt !== undefined && isGenericNativeGrantEligible(actionId)
            ? "session-grant"
            : undefined;
    let dispatchConfirmed = dispatchAuthorization !== undefined;
    // Tracks whether a live "tool-call-started" push fired for this dispatch so
    // the shared `finally` only emits the matching "settled" push for calls the
    // activity strip is actually showing (#9759). Pre-dispatch rejections never
    // reach the IIFE, so they never set this — and never settle the strip.
    let toolCallStartedEmitted = false;
    let toolCallStartedDanger = false;
    let toolCallStartedAsks = false;
    const emitToolCallStarted = (danger: boolean, asks: boolean): void => {
      if (!announceCallStarted(notifyToolCallStarted, facts, danger, asks)) return;
      toolCallStartedEmitted = true;
      toolCallStartedDanger = danger;
      toolCallStartedAsks = asks;
    };

    // Read at call time, not captured: the skip preference is settled once the
    // manifest entry is known, well after this is defined.
    const dispatchToRenderer = (id: string, dispatchArgs: unknown): Promise<DispatchEnvelope> =>
      relayCallId !== undefined
        ? dispatchAction(
            id,
            dispatchArgs,
            dispatchConfirmed,
            dispatchAuthorization === "skip-preference" ? dispatchAuthorization : undefined,
            relayCallId
          )
        : dispatchAuthorization === "skip-preference"
          ? dispatchAction(id, dispatchArgs, dispatchConfirmed, dispatchAuthorization)
          : dispatchAction(id, dispatchArgs, dispatchConfirmed);

    const { askForApproval, askToClose, mintSessionApproval } = createCallApprovals(
      { sessionStore, requestApproval, requestCloseApproval },
      facts,
      ownedResource,
      {
        recordOutcome: (next) => {
          outcome = next;
        },
        recordConfirmationDecision: (decision) => {
          confirmationDecision = decision;
        },
        preconfirm: (authorization) => {
          dispatchConfirmed = true;
          dispatchAuthorization = authorization;
        },
      }
    );

    // Wrapped in an inner IIFE so the dedup guard below can register this
    // Promise in `dedupInFlight` (singleflight) and attach a `.then()` cache
    // hook that fires before any other awaiter sees the resolved result.
    const dispatchPromise: Promise<CallToolResultLike> = (async () => {
      try {
        // An assistant named by agent messaging (#13496), resolved for the
        // assistant this call came from: in its own project, never itself. No
        // other caller may name one at all, so its refusal reads the same as
        // an id nothing here holds, and nothing reaches a view or a terminal.
        const assistantIds =
          assistantControl !== undefined &&
          (ASSISTANT_TARGET_TOOLS.has(actionId) || ASSISTANT_WATCH_TOOLS.has(actionId))
            ? namedTerminalIds(args).filter((id) => assistantControl.isAssistantTerminal(id))
            : [];
        if (assistantIds.length > 0) {
          const unreachable =
            assistantCaller === null
              ? assistantIds[0]
              : assistantIds.find((id) => assistantControl!.resolve(assistantCaller, id) === null);
          if (unreachable !== undefined) {
            const message =
              assistantCaller === null
                ? `No terminal '${unreachable}' is available to this connection.`
                : `No assistant in this project runs as terminal '${unreachable}'. List them with 'assistant.list'.`;
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: "NOT_FOUND", message } },
            };
            return buildToolError({
              code: assistantCaller === null ? "NOT_FOUND" : ASSISTANT_TARGET_REFUSALS.notFound,
              message,
            });
          }
        }
        const assistantTarget: AssistantTarget | undefined =
          assistantIds.length > 0 &&
          assistantCaller !== null &&
          ASSISTANT_TARGET_TOOLS.has(actionId)
            ? (assistantControl!.resolve(assistantCaller, assistantIds[0]!) ?? undefined)
            : undefined;

        // Status for named assistants is read off the pty-host (#13496): no
        // view's panels hold one. Ids that aren't assistants are read the same
        // way, from the caller's own project.
        if (
          actionId === TERMINAL_GET_STATUS_TOOL &&
          assistantIds.length > 0 &&
          assistantCaller !== null
        ) {
          emitToolCallStarted(false, false);
          try {
            const result = await handleTerminalGetStatusViewless(
              args,
              assistantCaller.projectId,
              new Set(assistantIds)
            );
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // Ownership gate for the `*Owned` tools (#11909). Placed at the
        // very top of the IIFE: a session that does not own the named resource
        // is refused here, before the activity strip is told a call started,
        // before any confirmation is raised, and — the acceptance criterion
        // that matters — before anything reaches a renderer, so a refused call
        // cannot have mutated a panel or a worktree.
        // An assistant target answers to its own rules below, not the ledger.
        // A worker the global Assistant names that the ledger doesn't give it
        // (#14551). Its own launches and hand-overs keep the owned path, so
        // the strict checks below never change what it could already do.
        // Keyed on the relay caller its Shell's runtime named, never on args.
        const steerTerminalId =
          deps.relay?.global === true &&
          deps.globalSteer !== undefined &&
          GLOBAL_STEER_TOOLS.has(actionId) &&
          ownedResource !== undefined &&
          assistantTarget === undefined
            ? readOwnedResourceId(args, ownedResource.idArg)
            : undefined;
        const globalSteerTerminalId =
          steerTerminalId !== undefined &&
          ownedRecordFor(ownedResource!.resourceKind, steerTerminalId) === undefined &&
          adoptedRecordFor(ownedResource!.resourceKind, steerTerminalId) === undefined
            ? steerTerminalId
            : undefined;
        // A reveal is no write: it goes out on the owned reveal's own dispatch
        // below, once the steer's gate has let it (#16096).
        if (globalSteerTerminalId !== undefined && actionId === GLOBAL_REVEAL_TOOL) {
          globalRevealTerminalId = globalSteerTerminalId;
          ownedResourceId = globalSteerTerminalId;
        }

        if (
          ownedResource !== undefined &&
          assistantTarget === undefined &&
          globalSteerTerminalId === undefined
        ) {
          const resourceId = readOwnedResourceId(args, ownedResource.idArg);
          if (resourceId === undefined) {
            const message =
              `Action '${actionId}' requires a non-empty '${ownedResource.idArg}' naming a resource ` +
              `this session created.`;
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: "VALIDATION_ERROR", message } },
            };
            return buildToolError({ code: "VALIDATION_ERROR", message });
          }
          // Daintree's own assistant also reads by the view it is pinned to
          // (#12883): it holds unscoped input to every pane in that view, so a
          // pane the user started is one it can already answer, and the
          // question behind the answer is what it needs. A pane it created
          // stays readable by the ledger, as every session's does, so a view
          // check that cannot answer never strands its own panes (#13439); the
          // view is asked only about the rest. Every other `*Owned` tool keeps
          // its ledger and hand-over rules.
          const readsByPinnedView =
            rendererOwnedOrigin && actionId === TERMINAL_READ_LAST_MESSAGE_OWNED_TOOL;
          // A hand-over is consulted only after the ownership ledger, and only
          // by the tools that declare it enough (#12490). The cleanup tools
          // never reach it, so an adopted terminal cannot be closed through
          // one.
          const createdRecord = ownedRecordFor(ownedResource.resourceKind, resourceId);
          const inPinnedView =
            readsByPinnedView &&
            createdRecord === undefined &&
            (await deps.isTerminalInPinnedWorkspace?.(resourceId).catch(() => false)) === true;
          const record =
            createdRecord ??
            (ownedResource.acceptsAdoption && !readsByPinnedView
              ? adoptedRecordFor(ownedResource.resourceKind, resourceId)
              : undefined);
          // One message for "never existed", "another session's", and "the
          // user's" — see RESOURCE_NOT_OWNED_CODE for why the three must not be
          // distinguishable.
          if (record === undefined && !inPinnedView) {
            // The hand-over hint is a fact about this caller — a pane the user can
            // hand terminals to — never about the id, so it reads the same on
            // every miss and the refusal stays uniform (#12980).
            const handOverHint =
              ownedResource.acceptsAdoption &&
              !readsByPinnedView &&
              !rendererOwnedOrigin &&
              sessionStore.resourceOwnership.isPrincipalOwner(ownershipOwner);
            const sessionOwnershipNote = sessionScopedOwner && !readsByPinnedView;
            const refusal = readsByPinnedView
              ? `No agent ${ownedResource.resourceKind} with id '${resourceId}' is in the project this ` +
                `assistant is open in, so '${actionId}' will not read it. Take the id from ` +
                `'terminal.list' in this project.`
              : ownedResource.acceptsAdoption
                ? `No ${ownedResource.resourceKind} with id '${resourceId}' was created by this session or ` +
                  `handed to it by the user, so '${actionId}' will not act on it. This tool only acts on ` +
                  `terminals this connection created or the user handed to this pane; ids from listings ` +
                  `may belong to the user, another client, or a plugin.`
                : `No ${ownedResource.resourceKind} with id '${resourceId}' was created by this session, so ` +
                  `'${actionId}' will not act on it. This tool only acts on resources this ` +
                  `connection created; ids from listings may belong to the user, another client, or a plugin.`;
            const error: import("../../../shared/types/actions.js").ActionError = handOverHint
              ? {
                  code: RESOURCE_NOT_OWNED_CODE,
                  message: `${refusal} ${HAND_OVER_HINT}`,
                  details: { grantPath: HAND_OVER_GRANT_PATH },
                }
              : {
                  code: RESOURCE_NOT_OWNED_CODE,
                  message: sessionOwnershipNote ? `${refusal} ${SESSION_OWNERSHIP_NOTE}` : refusal,
                };
            outcome = { kind: "result", value: { ok: false, error } };
            return buildToolError(error);
          }
          ownedResourceId = resourceId;
          ownedResourceRecord = record;
          admittedAdoption =
            createdRecord === undefined && !readsByPinnedView
              ? sessionStore.terminalAdoption.get(ownershipOwner, resourceId)
              : undefined;
        }

        // An owned worktree delete waits for every process in the worktree to
        // exit (#15729): `worktree.delete` closes nothing without
        // `closeTerminals`, which this tool never sends, and git removes the
        // directory from under whatever still runs there — a pane this
        // session just closed that is still in its trash grace, or a terminal
        // it never owned. Asked of the pty-host after ownership is settled, so
        // an unowned id is still refused uniformly and never learns what runs
        // in it, and before any question reaches the user. The delete's own D2
        // dialog opens inside the delegated dispatch, so a terminal started
        // while that dialog is up is not seen here. Only an owned delete
        // awaits anything here: every other call keeps the tick ordering it
        // had, which a reply wait set up above is sensitive to.
        //
        // Creation is read from the launch history, keyed by the run main
        // tracks under the id, because a close releases the ledger record
        // while the trashed process runs on — and a ledger record outlives a
        // respawn the person made under the same id, so it never speaks for a
        // run whose generation is known.
        //
        // A retirement (#15737) also reads which closes are on record, so it
        // can wait for a pane this session already closed: only the close of
        // the run now under the id, since a respawn is not what it closed.
        const attributeWorktreeTerminal = (
          terminalId: string,
          launchGeneration: number | undefined
        ): RetirementAttribution => {
          const ledgerRecord = ownedRecordFor("terminal", terminalId) !== undefined;
          const createdByThisSession =
            launchGeneration === undefined
              ? ledgerRecord
              : sessionStore.workerCreations.get(terminalId, launchGeneration)?.owner ===
                ownershipOwner;
          const closed = sessionStore.resourceOwnership.closedRecord(ownershipOwner, terminalId);
          return {
            createdByThisSession,
            closableByThisSession: createdByThisSession && ledgerRecord,
            closedByThisSession:
              closed?.launchGeneration !== undefined &&
              closed.launchGeneration === launchGeneration,
          };
        };
        if (actionId === WORKTREE_DELETE_OWNED_TOOL && ownedResourceId !== undefined) {
          const refusal = await refuseWorktreeDeleteWhileRunning(
            ownedResourceId,
            deps.readTerminalProcesses,
            attributeWorktreeTerminal
          );
          if (refusal !== undefined) {
            outcome = { kind: "result", value: { ok: false, error: refusal } };
            return buildToolError(refusal);
          }
        }

        // A retirement's checks that change nothing (#15737), in the same
        // place as the owned delete's: after ownership, so an unowned id is
        // refused uniformly and learns nothing about the worktree, and before
        // anything asks the user, so a dirty tree or someone else's process
        // never raises a question. Clean and pushed first, from git; then the
        // census, which also says what the teardown closes and waits for.
        if (actionId === WORKTREE_RETIRE_OWNED_TOOL && ownedResourceId !== undefined) {
          const parsed = WorktreeRetireOwnedArgsSchema.safeParse(args);
          if (!parsed.success) {
            const error: ActionError = {
              code: "VALIDATION_ERROR",
              message: `Invalid arguments: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
            };
            outcome = { kind: "result", value: { ok: false, error } };
            return buildToolError(error);
          }
          const refuse = (error: ActionError) => {
            outcome = { kind: "result", value: { ok: false, error } };
            return buildToolError(error);
          };
          let git: WorktreeGitObservation;
          try {
            if (deps.readWorktreeGit === undefined) throw new Error("No git reader.");
            git = await deps.readWorktreeGit(ownedResourceId, extra.signal);
          } catch {
            return refuse(untouched(gitUnreadableRefusal(ownedResourceId)));
          }
          const unclean = refuseUnlessCleanAndPushed(ownedResourceId, git);
          if (unclean !== undefined || git.headOid === null) {
            return refuse(untouched(unclean ?? gitUnreadableRefusal(ownedResourceId)));
          }
          const planned = await planWorktreeRetirement(
            ownedResourceId,
            deps.readTerminalProcesses,
            attributeWorktreeTerminal
          );
          if ("refusal" in planned) return refuse(planned.refusal);
          if (planned.plan.awaitExit.length > 0 && waitForClosedPanelExits === undefined) {
            return refuse(
              untouched({
                code: EXECUTION_ERROR_CODE,
                message:
                  `Worktree '${ownedResourceId}' was not retired: the pty host is not available, ` +
                  `so no process exit can be observed.`,
              })
            );
          }
          retirement = {
            worktreeId: ownedResourceId,
            plan: planned.plan,
            timeoutMs: parsed.data.timeoutMs ?? DEFAULT_TERMINAL_EXIT_WAIT_MS,
            git: { ...git, headOid: git.headOid },
          };
        }

        // The ask for a pane call above its tier (#12692). Placed after the
        // ownership gate, so a call that would be refused anyway never puts a
        // question to the user, and before every executor — main-only ones
        // included — so nothing runs until they have answered. Inside the
        // singleflight promise, so a duplicate creation call shares one ask.
        if (approvalRequired) {
          const refusal = await askForApproval();
          if (refusal !== undefined) return refusal;
        }

        // The assistant closing a panel it did not open, or one whose agent is
        // mid-task (#12881). Asked before anything reaches the renderer, like
        // the ownership gate above; a batch has already asked about the whole
        // set and marks its items so they do not ask again. Under the skip
        // preference (#12989) it runs without asking, and is audited as such.
        if (
          rendererOwnedOrigin &&
          actionId === "terminal.close" &&
          assistantTarget === undefined &&
          batchItem?.closeApproved !== true
        ) {
          const terminalId = readStringArg(args, "terminalId");
          if (
            terminalId !== undefined &&
            terminalId.length > 0 &&
            (await closeNeedsApproval(terminalId))
          ) {
            if (confirmationsSkipped) {
              dispatchAuthorization = "skip-preference";
              dispatchConfirmed = true;
            } else {
              // Announced before the wait, so the strip shows the call awaiting
              // the user rather than nothing at all until they answer.
              emitToolCallStarted(true, true);
              const asked = await askToClose([terminalId]);
              if ("refusal" in asked) return asked.refusal;
              if (!asked.approved.has(terminalId)) {
                const message = `The user did not approve closing '${terminalId}'. Nothing was closed.`;
                outcome = {
                  kind: "result",
                  value: { ok: false, error: { code: USER_REJECTED_CODE, message } },
                };
                return buildToolError({ code: USER_REJECTED_CODE, message });
              }
            }
          }
        }

        // A main-executed owned tool (#12479) runs straight after the gate
        // above and before anything resolves a renderer manifest, so a
        // workspace with no live view still answers it. The executor is handed
        // the checked id and the options its entry validated, and nothing else
        // the caller sent — the same rebuild the delegated tools get. Read-only
        // and never `danger: "confirm"`, so the strip shows a plain in-flight
        // row; audit and strip-settle unify via the shared `finally`.
        if (ownedResource?.executor === "main" && ownedResourceId !== undefined) {
          const read = ownedResource.readOptions(args);
          if (!read.ok) {
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: "VALIDATION_ERROR", message: read.message } },
            };
            return buildToolError({ code: "VALIDATION_ERROR", message: read.message });
          }
          emitToolCallStarted(false, false);
          try {
            const result = await deps[ownedResource.handler](
              ownedResourceId,
              read.options,
              extra.signal
            );
            outcome = { kind: "result", value: { ok: true, result } };
            // The same success bookkeeping the delegated owned tools get on
            // the renderer path: a grant that admitted the call slides its
            // window, and the session's idle timer restarts.
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // A launch argument that would otherwise hand a session authority it
        // was never given (#12407), refused before anything reaches a renderer.
        //
        // A caller-chosen panel id that is already live does not create a
        // terminal: the renderer commits a panel under that id, reports the
        // launch, and the spawn is then refused with the original shell still
        // running. The ledger would record that shell as this session's, and
        // the owned input tools would type into it. A collision is never a
        // legitimate request, so this applies to every origin.
        if (
          actionId === AGENT_LAUNCH_TOOL &&
          typeof args === "object" &&
          args !== null &&
          !Array.isArray(args) &&
          readStringArg(args, "requestedId") === undefined
        ) {
          (args as Record<string, unknown>).requestedId = shortAgentTerminalId(
            readStringArg(args, "agentId"),
            deps.isTerminalIdInUse
          );
        }
        if (AGENT_NAMING_LAUNCH_TOOLS.has(actionId)) {
          // Checked on the composite too, before it creates a worktree its
          // launch would then be refused into.
          const requestedId =
            actionId === AGENT_LAUNCH_TOOL || actionId === AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL
              ? readStringArg(args, "requestedId")
              : undefined;
          if (requestedId !== undefined && deps.isTerminalIdInUse(requestedId)) {
            const message =
              `A terminal with id '${requestedId}' already exists, so '${actionId}' will not ` +
              `launch under it. Omit the requested id, or choose one no terminal is using.`;
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: "VALIDATION_ERROR", message } },
            };
            return buildToolError({ code: "VALIDATION_ERROR", message });
          }
        }

        // One unit of work in one call (#15738): the create, the setup wait
        // and the launch each run through this handler again as their single
        // calls, so the session owns what they make, the launch's notice and
        // reply wait work as on `agent.launch`, and each step dispatches with
        // no view where it can. The composite adds no authority of its own.
        if (actionId === AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL) {
          // What the launch step would refuse `notify` for is refused here,
          // before a worktree is made for an agent that won't be launched.
          if (
            typeof args === "object" &&
            args !== null &&
            (args as Record<string, unknown>).notify === true
          ) {
            const refuse = (code: string, message: string) => {
              outcome = {
                kind: "result",
                value: { ok: false, error: { code: auditCodeForNotifyRefusal(code), message } },
              };
              return buildToolError({ code, message });
            };
            const pane = tier === "external" ? null : ownPane();
            if (pane === null || terminalNotify === undefined) {
              return refuse(
                NOTIFY_NOT_ELIGIBLE,
                "`notify` types into the caller's own pane, and this connection has none: only an agent pane or an assistant session can ask for it. Nothing was created."
              );
            }
            if (pane.relay !== undefined && pane.relay.callId === undefined) {
              return refuse(
                NOTIFY_NOT_ELIGIBLE,
                "This relayed call carries no call id, so its notice could not reach the assistant that asked. Nothing was created."
              );
            }
            if ((readStringArg(args, "prompt") ?? "").trim().length === 0) {
              return refuse(
                NOTIFY_VALIDATION_ERROR,
                "`notify` needs a `prompt`: there is no work to finish without one. Nothing was created."
              );
            }
          }
          emitToolCallStarted(false, false);
          const stepOptions =
            confirmationsSkipped || relayCallId !== undefined
              ? {
                  ...(confirmationsSkipped ? { confirmationsSkipped: true } : {}),
                  ...(relayCallId !== undefined ? { relayCallId } : {}),
                }
              : undefined;
          try {
            const answer = await runLaunchInNewWorktree(args, {
              callTool: (name, stepArgs) =>
                handleCallTool(
                  { method: "tools/call", params: { name, arguments: stepArgs } },
                  extra,
                  stepOptions
                ),
              signal: extra.signal,
              ...(dedupKey !== undefined
                ? { createRequestKey: createStepRequestKey(dedupKey) }
                : {}),
            });
            outcome = { kind: "result", value: answer.outcome };
            return answer.result;
          } catch (err) {
            outcome = { kind: "throw", error: err };
            throw err;
          }
        }

        // A batch is its items: each runs through this handler again as its
        // single call, so tier, ownership, notices and audit apply per item
        // exactly as one at a time. The batch itself is admitted and audited
        // above like any call, and adds no authority of its own.
        const batch = BATCH_TOOLS[actionId];
        if (batch !== undefined) {
          const parsed = batch.schema.safeParse(args ?? {});
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new McpError(
              ErrorCode.InvalidParams,
              `${actionId}: ${issue?.message ?? "invalid arguments"}${
                issue && issue.path.length > 0 ? ` at '${issue.path.map(String).join(".")}'` : ""
              }.`
            );
          }
          // One question for the whole set (#12881), asked before any item
          // runs: a decline closes nothing, and the items the user approved
          // carry that approval so none of them asks again. Under the skip
          // preference (#12989) nothing is asked and the batch is audited as
          // run under it; its items carry the same answer, never an approval.
          let closeApproved: ReadonlySet<string> | undefined;
          // An assistant is never put to the person here: its own item
          // checks who started it, and one this caller can't reach is
          // answered as missing (#13496).
          const isAssistantId = (id: string) => assistantControl?.isAssistantTerminal(id) === true;
          const closeIds =
            actionId === "terminal.closeMany" && rendererOwnedOrigin
              ? [...new Set((parsed.data as TerminalCloseManyArgs).terminalIds)].filter(
                  (id) => !isAssistantId(id)
                )
              : [];
          const closeWouldAsk = (await Promise.all(closeIds.map(closeNeedsApproval))).some(Boolean);
          if (closeWouldAsk && confirmationsSkipped) {
            dispatchAuthorization = "skip-preference";
            dispatchConfirmed = true;
          }
          const closeNeedsAsking = closeWouldAsk && !confirmationsSkipped;
          emitToolCallStarted(closeNeedsAsking, closeNeedsAsking);
          if (closeNeedsAsking) {
            const asked = await askToClose(closeIds);
            if ("refusal" in asked) return asked.refusal;
            closeApproved = asked.approved;
          }
          const results: BatchItemOutcome[] = [];
          const batchArgs = parsed.data as {
            waitForReply?: boolean;
            waitSeconds?: number;
            replyLines?: number;
            notify?: boolean;
          };
          // Each item's notice holds while its reply wait runs.
          const noticePane =
            batchArgs.notify === true && terminalNotify !== undefined && tier !== "external"
              ? ownPane()
              : null;
          // Every item is sent first and waited on together, so the call lasts
          // as long as the slowest agent, not the sum of them.
          const waits: Array<ReplyWait | undefined> = [];
          for (const item of batch.expand(parsed.data, rendererOwnedOrigin)) {
            // A cancelled call starts nothing more; what already went out stands.
            if (extra.signal.aborted) break;
            if (
              closeApproved !== undefined &&
              !closeApproved.has(item.target) &&
              !isAssistantId(item.target)
            ) {
              waits.push(undefined);
              results.push({
                target: item.target,
                ok: false,
                error: {
                  code: USER_REJECTED_CODE,
                  message:
                    "This panel was not approved for closing, so it was not closed. Do not retry it or ask again on its behalf.",
                },
              });
              continue;
            }
            const wait =
              batchArgs.waitForReply === true && replyWaiter !== undefined
                ? replyWaiter.wait({
                    ...(item.tool === AGENT_LAUNCH_TOOL
                      ? {}
                      : { terminalId: item.target, expectsToken: true }),
                    since: Date.now(),
                    replyLines: batchArgs.replyLines ?? NOTIFY_REPLY_LINES_DEFAULT,
                    timeoutMs: (batchArgs.waitSeconds ?? REPLY_WAIT_DEFAULT_SECONDS) * 1_000,
                    signal: extra.signal,
                  })
                : undefined;
            const noticeHold =
              wait !== undefined && noticePane !== null ? createNoticeHold() : undefined;
            // Settled once the item is back, so the launch's notice exists by then.
            const releaseItemNotice = () => {
              if (wait === undefined || noticeHold === undefined || noticePane === null) return;
              releaseNoticeAfter(wait, (answered, stoppedWithoutMarker) =>
                terminalNotify?.releaseHold(noticePane, noticeHold, answered, stoppedWithoutMarker)
              );
            };
            let itemResult: CallToolResult;
            try {
              itemResult = await handleCallTool(
                { method: "tools/call", params: { name: item.tool, arguments: item.args } },
                extra,
                noticeHold !== undefined ||
                  closeApproved !== undefined ||
                  confirmationsSkipped ||
                  relayCallId !== undefined
                  ? {
                      ...(noticeHold !== undefined ? { noticeHold } : {}),
                      ...(closeApproved !== undefined ? { closeApproved: true } : {}),
                      ...(confirmationsSkipped ? { confirmationsSkipped: true } : {}),
                      ...(relayCallId !== undefined ? { relayCallId } : {}),
                    }
                  : undefined
              );
            } catch (error) {
              // One item's refusal is its own outcome, not the batch's.
              wait?.cancel();
              releaseItemNotice();
              waits.push(undefined);
              results.push({
                target: item.target,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              });
              continue;
            }
            if (wait !== undefined) bindWait(itemResult, wait);
            releaseItemNotice();
            waits.push(wait);
            results.push(batchItemOutcome(item.target, itemResult));
          }
          const replies = await Promise.all(waits.map((wait) => wait?.promise));
          // Share the response ceiling so every item's receipt survives:
          // replies are trimmed from their start, keeping their ends.
          const replyBudget = Math.floor(BATCH_REPLY_TEXT_BUDGET / Math.max(1, replies.length));
          replies.forEach((reply, index) => {
            const entry = results[index];
            if (entry !== undefined && reply !== undefined && reply.terminalId !== "") {
              const text = reply.reply?.text;
              entry.reply =
                text !== undefined && text.length > replyBudget
                  ? {
                      ...reply,
                      reply: { ...reply.reply!, text: text.slice(-replyBudget), truncated: true },
                    }
                  : reply;
            }
          });
          const value = { results };
          outcome = { kind: "result", value: { ok: true, result: value } };
          return buildToolCallResult(value, {
            structuredContent: value as unknown as Record<string, unknown>,
          }) as CallToolResult;
        }

        if (waitForReply && replyWaiter !== undefined) {
          replyWait = replyWaiter.wait({
            ...(actionId === AGENT_LAUNCH_TOOL
              ? {}
              : {
                  terminalId: ownedResourceId ?? readStringArg(args, "terminalId"),
                  expectsToken: true,
                }),
            since: Date.now(),
            replyLines: replyLines ?? NOTIFY_REPLY_LINES_DEFAULT,
            timeoutMs: (waitSeconds ?? REPLY_WAIT_DEFAULT_SECONDS) * 1_000,
            signal: extra.signal,
          });
        }

        // `notify: true` on a send or launch: the notice is set up here, before
        // the prompt goes out, so none of the target's state changes can slip
        // past it. Refused before anything reaches a renderer when there is no
        // pane to type into — an api-key client has none — so a caller is
        // never told its prompt went out with a promise nobody will keep.
        if (notify) {
          const refuse = (code: string, message: string) => {
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: auditCodeForNotifyRefusal(code), message } },
            };
            return buildToolError({ code, message });
          };
          const pane = tier === "external" ? null : ownPane();
          if (pane === null || terminalNotify === undefined) {
            return refuse(
              NOTIFY_NOT_ELIGIBLE,
              "`notify` types into the caller's own pane, and this connection has none: only an agent pane or an assistant session can ask for it. Nothing was sent."
            );
          }
          const hold =
            batchItem?.noticeHold ??
            (waitForReply && replyWaiter !== undefined ? createNoticeHold() : undefined);
          const handback =
            typeof args === "object" &&
            args !== null &&
            (args as Record<string, unknown>).handback === true;
          const noticeOptions = {
            replyLines,
            ...(hold !== undefined ? { hold } : {}),
            ...(handback ? { handback } : {}),
          };
          try {
            if (actionId === AGENT_LAUNCH_TOOL) {
              if ((readStringArg(args, "prompt") ?? "").trim().length === 0) {
                return refuse(
                  NOTIFY_VALIDATION_ERROR,
                  "`notify` needs a `prompt`: there is no work to finish without one. Nothing was launched."
                );
              }
              pendingNotify = await terminalNotify.prepareLaunch(pane, noticeOptions);
            } else if (NOTIFY_KEY_TOOLS.has(actionId)) {
              const targetId = ownedResourceId ?? readStringArg(args, "terminalId");
              if (targetId === undefined || targetId.length === 0) {
                return refuse(NOTIFY_VALIDATION_ERROR, "`notify` needs a `terminalId`.");
              }
              pendingNotify = await terminalNotify.prepareKeys(pane, targetId, { replyLines });
            } else {
              const targetId = ownedResourceId ?? readStringArg(args, "terminalId");
              if (targetId === undefined || targetId.length === 0) {
                return refuse(NOTIFY_VALIDATION_ERROR, "`notify` needs a `terminalId`.");
              }
              pendingNotify = await terminalNotify.prepareSend(pane, targetId, noticeOptions);
            }
          } catch (err) {
            if (err instanceof TerminalNotifyError) return refuse(err.code, err.message);
            throw err;
          }
          // A batch settles its items' holds itself, as each item's wait ends.
          if (hold !== undefined && batchItem?.noticeHold === undefined) {
            releaseNotice = (answered, stoppedWithoutMarker) =>
              terminalNotify.releaseHold(pane, hold, answered, stoppedWithoutMarker);
          }
        }

        // A pane closing a terminal it asked about needs no notice saying so.
        if (NOTIFY_CLOSE_TOOLS.has(actionId) && terminalNotify !== undefined) {
          const pane = tier === "external" ? null : ownPane();
          const targetId = ownedResourceId ?? readStringArg(args, "terminalId");
          if (pane !== null && targetId !== undefined) terminalNotify.forgetTarget(pane, targetId);
        }
        if (
          NOTIFY_RESTART_TOOLS.has(actionId) &&
          terminalNotify !== undefined &&
          ownedResourceId !== undefined
        ) {
          const pane = tier === "external" ? null : ownPane();
          if (pane !== null) {
            const hold = createNoticeHold();
            terminalNotify.holdTarget(pane, ownedResourceId, hold);
            settleRestartHold = (replaced) => terminalNotify.settleTargetHold(pane, hold, replaced);
          }
        }

        // Short-circuit: terminal.waitUntilIdle runs in the main process. The
        // action manifest entry handles schema, tier, and audit registration; the
        // execution must bypass renderer dispatch because (a) the MCP AbortSignal
        // can't cross IPC, and (b) renderer dispatch has a 30s wall — too short
        // for the multi-hour waits external sessions may request. Audit unifies
        // via the shared finally.
        if (actionId === TERMINAL_WAIT_UNTIL_IDLE_TOOL) {
          // waitUntilIdle is never `danger: "confirm"` — it's a passive wait,
          // so the strip shows a plain in-flight row (no "awaiting confirmation").
          emitToolCallStarted(false, false);
          try {
            // Interactive help sessions (core/full tiers) have a
            // human waiting on the conversation — a tool call held open blocks
            // the whole session, so the wait is clamped to the interactive cap
            // and the agent re-polls on `timedOut: true`. External (api-key)
            // sessions are headless scripts; they keep the full 2h ceiling.
            const maxTimeoutMs =
              tier === "external"
                ? MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS
                : INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS;
            // A bound session's output-progress reads stay inside its own
            // workspace (#12428); the wait itself is unchanged.
            const result = await waitUntilIdle(args, extra.signal, {
              maxTimeoutMs,
              ...(workspaceBinding ? { workspaceId: workspaceBinding.workspaceId } : {}),
            });
            outcome = { kind: "result", value: { ok: true, result } };
            // Mirror the post-dispatch grant refresh in the main path:
            // when the call was authorized by a grant, extend the TTL
            // window and reset the idle timer on success. `waitUntilIdle`
            // can run up to 2 hours on external sessions (longer than the
            // 15-min grant window), so this is the only block that prevents
            // the grant from silently aging out during a long wait (#8442).
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "waitUntilIdle failed"),
            });
          }
        }

        // Short-circuit: terminal.waitUntilIdleBatch is the batched sibling of
        // waitUntilIdle (watch N terminals, resolve on first/all idle). Same
        // main-process rationale and tier clamp; same grant-refresh-on-long-wait.
        if (actionId === TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL) {
          emitToolCallStarted(false, false);
          try {
            const maxTimeoutMs =
              tier === "external"
                ? MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS
                : INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS;
            const result = await waitUntilIdleBatch(args, extra.signal, {
              maxTimeoutMs,
              ...(workspaceBinding ? { workspaceId: workspaceBinding.workspaceId } : {}),
            });
            outcome = { kind: "result", value: { ok: true, result } };
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "waitUntilIdleBatch failed"),
            });
          }
        }

        // Short-circuit: terminal.getStatus, read off the pty-host, when the
        // bound workspace has no live view (#12316). Unlike its siblings here
        // this is a *fallback*, not the tool's home: the renderer answer knows
        // panel identity, arming and the parsed check result, and is used
        // whenever a view exists. The flag is set by the bound ceiling above,
        // from the binding failure it already resolved, so this branch never
        // decides for itself that a view is missing.
        //
        // Read-only and never `danger: "confirm"` — the strip shows a plain
        // in-flight row. Audit and strip-settle unify via the shared `finally`.
        if (viewlessStatusWorkspaceId !== undefined) {
          emitToolCallStarted(false, false);
          try {
            const result = await handleTerminalGetStatusViewless(args, viewlessStatusWorkspaceId);
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // Short-circuit: `terminal.notifyWhenIdle` is session state in main —
        // which pane to type into is known only from the credential, and the
        // notice outlives the call. Never `danger: "confirm"`; arming types
        // nothing, and the line it may later cause goes only to the caller's
        // own prompt. Audit + strip-settle unify via the shared `finally`.
        if (actionId === TERMINAL_NOTIFY_WHEN_IDLE_TOOL) {
          emitToolCallStarted(false, false);
          const refuse = (code: string, message: string) => {
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: auditCodeForNotifyRefusal(code), message } },
            };
            return buildToolError({ code, message });
          };
          // An api-key client has no pane of its own. The external allowlist
          // already withholds this tool; this keeps it true if that drifts.
          const pane = tier === "external" ? null : ownPane();
          if (pane === null || terminalNotify === undefined) {
            return refuse(
              NOTIFY_NOT_ELIGIBLE,
              "Notices are typed into the caller's own pane, and this connection has none: only an agent pane or an assistant session can ask for one."
            );
          }
          try {
            const result = await runNotifyWhenIdleTool(args, pane, terminalNotify);
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            if (err instanceof TerminalNotifyError) return refuse(err.code, err.message);
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // Short-circuit: a Shell assistant's host tools (#13493) run in main
        // over the link. Only an assistant running in one of this machine's
        // own views gets past the runtime's own check (#13468), whatever
        // admitted the call above. Named outcomes (opted out, unreachable,
        // ambiguous, ...) are results; refusals are fixed text, and the audit
        // projections keep results out of the log.
        if (HOST_CONTROL_TOOL_IDS.has(actionId)) {
          emitToolCallStarted(false, false);
          try {
            // `host.call` carries the tier it was admitted at here: all it may have on the host.
            // Its record says when what it ran there ran under this machine's
            // own skip preference (#15698), which only this machine decides.
            const callContext =
              actionId === HOST_CALL_TOOL && (tier === "core" || tier === "full")
                ? {
                    tier,
                    noteSkipPreference: () => {
                      dispatchAuthorization = "skip-preference";
                    },
                  }
                : undefined;
            const settled = await runHostControlTool(
              actionId,
              args,
              hostControl !== undefined && sessionStore.sessionHelpIdMap.has(sessionId)
                ? hostControl
                : undefined,
              callContext
            );
            if (!settled.ok) {
              outcome = {
                kind: "result",
                value: {
                  ok: false,
                  error: {
                    code: auditCodeForHostControlRefusal(settled.code),
                    message: settled.message,
                  },
                },
              };
              return buildToolError({ code: settled.code, message: settled.message });
            }
            const result = settled.value;
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: `${actionId} failed`,
            });
          }
        }

        // Short-circuit: finding and starting an assistant, and this machine's
        // quota (#13496), run in main for the assistant this call came from,
        // whatever admitted it above. A start is a change this process makes
        // itself, so a relayed one answers to the drive rule as a check does.
        if (ASSISTANT_CONTROL_TOOL_IDS.has(actionId)) {
          emitToolCallStarted(false, false);
          const refuseAssistant = (code: string, message: string) => {
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: auditCodeForAssistantRefusal(code), message } },
            };
            return buildToolError({ code, message });
          };
          if (assistantCaller === null || assistantControl === undefined) {
            return refuseAssistant("RESTRICTED", ASSISTANT_CONTROL_REFUSAL);
          }
          try {
            let result: unknown;
            if (actionId === ASSISTANT_LIST_TOOL) {
              result = await assistantControl.list(assistantCaller);
            } else if (actionId === ASSISTANT_START_TOOL) {
              const parsed = AssistantStartArgsSchema.safeParse(args ?? {});
              if (!parsed.success) {
                return refuseAssistant(
                  "VALIDATION_ERROR",
                  "The arguments don't match this tool's schema."
                );
              }
              const startRefusal = assistantWriteRefusal(assistantCaller.projectId);
              if (startRefusal) return refuseAssistant(startRefusal.code, startRefusal.message);
              result = await assistantControl.start(assistantCaller, parsed.data);
            } else {
              const readQuota = deps.readCodexQuota;
              if (readQuota === undefined) {
                return refuseAssistant(
                  EXECUTION_ERROR_CODE,
                  "This machine can't read its Codex quota."
                );
              }
              result = { codex: await readQuota() };
            }
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as Record<string, unknown>,
            });
          } catch (err) {
            if (err instanceof AssistantTargetError) return refuseAssistant(err.code, err.message);
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // Short-circuit: skills.search / skills.load run entirely in the main
        // process (#10892). The action manifest entries (renderer) carry
        // schema/tier/audit, but the skill registry — parsed plugin markdown —
        // only exists in main, so execution stays here rather than
        // round-tripping to a renderer that has no skill data. Synchronous
        // in-memory reads; never `danger: "confirm"`. Audit + strip-settle
        // unify via the shared `finally`.
        if (actionId === SKILLS_SEARCH_TOOL || actionId === SKILLS_LOAD_TOOL) {
          emitToolCallStarted(false, false);
          try {
            const result =
              actionId === SKILLS_SEARCH_TOOL ? handleSkillsSearch(args) : handleSkillsLoad(args);
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // Short-circuit: mcp.surface runs entirely in the main process (#11549).
        // The action manifest entry (renderer) carries schema/tier/audit, but
        // the answer cannot be built there: the caller's authorization tier is
        // session state that only main holds, and the renderer has no idea
        // which MCP session dispatched it. Building it here also means the
        // report and `tools/list` apply one `shouldExposeTool` gate to one
        // manifest, rather than a renderer-side enumeration that a post-dispatch
        // filter then has to narrow back down (#11525).
        //
        // Read-only and never `danger: "confirm"` — it reports what this session
        // was already told, so the strip shows a plain in-flight row.
        if (actionId === MCP_SURFACE_TOOL_ID) {
          emitToolCallStarted(false, false);
          try {
            const manifest = await resolveManifest(MCP_SURFACE_TOOL_ID);
            // Build against the tier captured at dispatch start — the one the
            // permission gate above actually authorized this call at — rather
            // than re-reading after the await. Authorization has one lifetime
            // per call: revocation stops the *next* request, but does not
            // rewrite a call already admitted, and an elevation or decay landing
            // mid-fetch belongs to the next request too. Re-reading would make
            // the report disagree with both the gate that admitted the call and
            // the audit record, which logs this same value. A tier that changes
            // mid-call fires `notifications/tools/list_changed`, so a client
            // re-reads anyway.
            const result = buildSurfaceManifest(
              manifest,
              tier,
              app.getVersion(),
              // Same binding and origin the gate above authorized this call
              // against, and the same ones `tools/list` filters by — so the
              // report can never advertise a tool the listing withholds
              // (#11789, #12407).
              {
                ...sessionSurface,
                rendererOwnedOrigin,
                hostCall: hostCallOffered(),
                assistantCaller: assistantCaller !== null,
              }
            );
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "mcp.surface failed"),
            });
          }
        }

        // A relayed write main makes itself answers with the drive rule's refusal (#13493).
        const refuseRelayed = (refusal: { code: string; message: string }) => {
          const auditCode = refusal.code === "VALIDATION_ERROR" ? "VALIDATION_ERROR" : "RESTRICTED";
          outcome = {
            kind: "result",
            value: { ok: false, error: { code: auditCode, message: refusal.message } },
          };
          return buildToolError(refusal);
        };

        // Short-circuit: terminal.waitForExit runs in main (#15728). The exits
        // it reports are ones main kept after the pty-host let a closed panel
        // go, and its authority is the ownership ledger's record of what this
        // owner closed, which no renderer can see. Never `danger: "confirm"`:
        // ending a grace early only brings forward the stop the close already
        // decided, for panels this caller closed itself.
        if (actionId === TERMINAL_WAIT_FOR_EXIT_TOOL) {
          emitToolCallStarted(false, false);
          const parsed = TerminalWaitForExitArgsSchema.safeParse(args);
          if (!parsed.success) {
            const error: ActionError = {
              code: "VALIDATION_ERROR",
              message: `Invalid arguments: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
            };
            outcome = { kind: "result", value: { ok: false, error } };
            return buildToolError(error);
          }
          const targets: ClosedPanelExitTarget[] = [];
          const closedIn = new Set<string | undefined>();
          for (const terminalId of new Set(parsed.data.terminalIds)) {
            const closed = sessionStore.resourceOwnership.closedRecord(ownershipOwner, terminalId);
            if (closed === undefined) {
              // One message for every miss, as for the owned tools: an id this
              // caller never closed reads the same whoever's it is.
              const error: ActionError = {
                code: RESOURCE_NOT_OWNED_CODE,
                message:
                  `No terminal with id '${terminalId}' was closed by this session in the last ` +
                  `10 minutes, so '${actionId}' will not wait for it. Nothing was waited for or ` +
                  `stopped. Pass ids this connection closed with a close tool.`,
              };
              outcome = { kind: "result", value: { ok: false, error } };
              return buildToolError(error);
            }
            targets.push({ terminalId, launchGeneration: closed.launchGeneration });
            closedIn.add(closed.workspaceId);
          }
          const endGrace = parsed.data.endGrace === true;
          // Asked now, and again right before each grace is ended.
          const graceRefusal = () => graceWriteRefusal(closedIn);
          if (endGrace) {
            const refusal = graceRefusal();
            if (refusal) return refuseRelayed(refusal);
          }
          if (waitForClosedPanelExits === undefined) {
            const error: ActionError = {
              code: EXECUTION_ERROR_CODE,
              message: "The pty host is not available, so no exit can be observed.",
            };
            outcome = { kind: "result", value: { ok: false, error } };
            return buildToolError(error);
          }
          try {
            const result = await waitForClosedPanelExits(targets, {
              timeoutMs: parsed.data.timeoutMs ?? DEFAULT_TERMINAL_EXIT_WAIT_MS,
              endGrace,
              signal: extra.signal,
              authorizeEndGrace: () => {
                const late = graceRefusal();
                if (late) throw new RelayWriteRefused(late);
              },
            });
            outcome = { kind: "result", value: { ok: true, result } };
            // A wait can run up to a minute, so it keeps the grant that
            // admitted it as the other waits do (#8442).
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            if (err instanceof RelayWriteRefused) return refuseRelayed(err.refusal);
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "waitForExit failed"),
            });
          }
        }

        // Short-circuit: project.runCheck runs entirely in the main process
        // (#11548). The action manifest entry (renderer) carries schema, tier,
        // and audit metadata, but execution must stay here because (a) it
        // spawns a real child process and reads its exit code, (b) the MCP
        // AbortSignal can't cross IPC — without it a runaway suite could never
        // be cancelled — and (c) renderer dispatch has a 30s wall, shorter than
        // almost any real test run. Same shape as the waitUntilIdle branch;
        // audit + strip-settle unify via the shared `finally`.
        if (actionId === PROJECT_RUN_CHECK_TOOL) {
          // Never `danger: "confirm"` — the runner is one the project already
          // declares, so the strip shows a plain in-flight row.
          emitToolCallStarted(false, false);
          // A relayed check runs only where its session is bound, and only while
          // the requesting Shell drives it there (#13493): asked now, and again
          // right before the spawn, since the checks between can take a while.
          const relay = deps.relay;
          const refuseWrite = relay
            ? (projectId: string | undefined) => relay.refuseWrite(projectId)
            : deps.refuseWrite;
          const checkProjectId = readStringArg(args, "projectId");
          const relayRefusal = refuseWrite?.(checkProjectId);
          if (relayRefusal) return refuseRelayed(relayRefusal);
          try {
            const result = await handleProjectRunCheck(
              args,
              extra.signal,
              refuseWrite
                ? () => {
                    const late = refuseWrite(checkProjectId);
                    if (late) throw new RelayWriteRefused(late);
                  }
                : undefined
            );
            outcome = { kind: "result", value: { ok: true, result } };
            // A check can outlive the 15-min grant window, so mirror the main
            // path's post-dispatch grant refresh — otherwise a long suite
            // silently ages the grant out mid-run (same reasoning as #8442).
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            if (err instanceof RelayWriteRefused) return refuseRelayed(err.refusal);
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            // Reaching here means the check could not start at all (unknown
            // runner, unusable cwd, busy target). A check that ran and failed
            // resolved above with `passed: false` — the two must stay
            // distinguishable to the caller.
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "project.runCheck failed"),
            });
          }
        }

        // Short-circuit: project.runCommand runs in main for the same reasons
        // as project.runCheck (#13495). Its caller was admitted above by
        // `mayRunProjectCommand`, and is asked again here so no future path
        // into this branch can skip it. Never `danger: "confirm"`: the same
        // assistant already reaches a shell through a terminal or an agent it
        // drives. A call relayed from another machine
        // (#13493) is a write under the drive rule, as a check is, since no
        // IPC channel's lease policy covers it: asked now, and again right
        // before the spawn.
        if (actionId === PROJECT_RUN_COMMAND_TOOL) {
          emitToolCallStarted(false, false);
          const relay = deps.relay;
          const refuseWrite = relay
            ? (projectId: string | undefined) => relay.refuseWrite(projectId)
            : deps.refuseWrite;
          const commandProjectId = readStringArg(args, "projectId");
          try {
            if (!commandRunnerCaller) {
              const message = PROJECT_RUN_COMMAND_REFUSAL;
              outcome = {
                kind: "result",
                value: { ok: false, error: { code: TIER_NOT_PERMITTED_CODE, message } },
              };
              return buildToolError({ code: TIER_NOT_PERMITTED_CODE, message });
            }
            const relayRefusal = refuseWrite?.(commandProjectId);
            if (relayRefusal) return refuseRelayed(relayRefusal);
            const result = await handleProjectRunCommand(
              args,
              extra.signal,
              refuseWrite
                ? () => {
                    const late = refuseWrite(commandProjectId);
                    if (late) throw new RelayWriteRefused(late);
                  }
                : undefined
            );
            outcome = { kind: "result", value: { ok: true, result } };
            // A command can outlive the grant window, as a check can.
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            if (err instanceof RelayWriteRefused) return refuseRelayed(err.refusal);
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "project.runCommand failed"),
            });
          }
        }

        // Short-circuit: help.displayImage runs entirely in the main process
        // (#9828). The action manifest entry handles schema/tier/audit; the URL
        // allowlist check, the per-session figure-number assignment, and the
        // imageId mint are authoritative state that must live here, not in the
        // renderer. The figure is pushed to the pinned WebContents via
        // `notifyDisplayImage`. Audit + strip-settle unify via the shared
        // `finally`. Never `danger: "confirm"` — it's a passive display.
        if (actionId === HELP_DISPLAY_IMAGE_TOOL) {
          emitToolCallStarted(false, false);
          try {
            // Help-session bearers only. A pane-token session can also resolve
            // to the core tier and clear the static allowlist gate above,
            // but it has no pinned panel to render the figure and no public
            // help-session id to key the counter, so reject it here.
            const helpSessionId = sessionStore.sessionHelpIdMap.get(sessionId);
            if (helpSessionId === undefined) {
              const message = "help.displayImage is only available to help sessions.";
              outcome = {
                kind: "result",
                value: { ok: false, error: { code: TIER_NOT_PERMITTED_CODE, message } },
              };
              return buildToolError({ code: TIER_NOT_PERMITTED_CODE, message });
            }
            // A session with no view has nowhere to show the figure (#13511).
            if (sessionStore.sessionViewlessHelpMap.has(sessionId)) {
              const message =
                "help.displayImage needs a Daintree window showing this assistant, and none does. Nothing was displayed.";
              outcome = {
                kind: "result",
                value: { ok: false, error: { code: NO_FRONTEND_ATTACHED_CODE, message } },
              };
              return buildToolError({ code: NO_FRONTEND_ATTACHED_CODE, message, retriable: true });
            }
            const params = (args ?? {}) as {
              url?: unknown;
              caption?: unknown;
              altText?: unknown;
            };
            const url = typeof params.url === "string" ? params.url : "";
            const validation = url
              ? validateDisplayImageUrl(url)
              : { valid: false as const, message: "A non-empty `url` string is required." };
            if (!validation.valid) {
              outcome = {
                kind: "result",
                value: {
                  ok: false,
                  error: { code: INVALID_URL_CODE, message: validation.message },
                },
              };
              return buildToolError({ code: INVALID_URL_CODE, message: validation.message });
            }
            const caption = typeof params.caption === "string" ? params.caption : undefined;
            const altText = typeof params.altText === "string" ? params.altText : undefined;
            const figureNumber = sessionStore.nextFigureNumber(helpSessionId);
            const figureLabel = `image #${figureNumber}`;
            const imageId = randomUUID();
            if (notifyDisplayImage) {
              try {
                notifyDisplayImage({
                  sessionId,
                  imageId,
                  figureNumber,
                  figureLabel,
                  url,
                  ...(caption !== undefined ? { caption } : {}),
                  ...(altText !== undefined ? { altText } : {}),
                });
              } catch (err) {
                console.error("[MCP] Failed to notify display-image:", err);
              }
            }
            const result = { imageId, figureNumber, figureLabel };
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "help.displayImage failed"),
            });
          }
        }

        let entry: import("../../../shared/types/actions.js").ActionManifestEntry | undefined;
        try {
          entry = await lookupManifestEntry(actionId, getCachedManifest, requestManifest);
        } catch (err) {
          if (!(err instanceof McpRouteBindingError)) throw err;
          // Narrow in practice — the bound guard above resolves a manifest
          // first — but reachable if the route is lost between the two.
          outcome = { kind: "throw", error: err };
          return buildToolError({
            code: bindingGoneCode(err),
            message: err.message,
            retriable: err.retriable,
          });
        }

        // An action the manifest doesn't describe has unknown danger, and
        // unknown is not safe: a stale or partial manifest that omits a
        // newly-registered confirm-gated action would otherwise let exactly the
        // call the guard above exists to refuse reach a renderer nobody is
        // watching (#11789). Sited here rather than beside that guard because
        // every main-process short circuit has already returned by this point,
        // so whatever is still running is renderer-bound by construction —
        // which beats maintaining a list of exempt tool ids that would silently
        // rot the next time a main-process tool is added.
        if (sessionSurface.workspaceBound && tier === "external" && entry === undefined) {
          const message =
            `Action '${actionId}' is not present in workspace '${workspaceBinding?.workspaceId}'s action surface, ` +
            `so this workspace-bound session cannot establish whether it needs confirmation. The action was not run.`;
          outcome = {
            kind: "result",
            value: { ok: false, error: { code: "NOT_FOUND", message } },
          };
          return buildToolError({ code: "NOT_FOUND", message });
        }

        // Announce the in-flight call now that `danger` is known — before the
        // host-side confirmation wait, so the strip can show "awaiting
        // confirmation" while the user decides on a `danger: "confirm"`
        // dispatch (#9759). Confirmation for `danger: "confirm"` is always
        // performed host-side: the unconfirmed `dispatchAction` below routes to
        // the renderer's native ConfirmDialog (or `CONFIRMATION_REQUIRED` when
        // no window is open). A client's self-declared `elicitation.form`
        // capability and its in-band elicitation response are NEVER treated as
        // proof of human authorization — a headless/agentic client could
        // otherwise self-approve its own destructive call (#11342). Only a
        // host-issued native grant (`nativeGrantId`) pre-authorizes a dispatch.
        //
        // The skip preference (#12874) is host state too, and is settled here
        // rather than beside the grants above because it hangs on the resolved
        // danger: stamping it on a safe call would put "ran without asking" on
        // calls that never could ask. The danger is the per-dispatch one the
        // renderer gates on, so a recipe id or a terminal launch target counts.
        // Unlike a native grant it covers the target-picking tools too
        // (#12989): `closeAll`, `killAll` and `killBatch` run on every target
        // the call named, and the bridge attests `killBatch`'s targets itself.
        // It wins over a native grant, which pre-authorizes only the D2 dialog:
        // under the skip there is no typed-name gate either. The grant's use is
        // still spent. The assistant's protected close (#12881) settles the
        // preference above, where it would otherwise ask.
        // With no frontend attached the lookup reads the host's generated base
        // surface; an action it lacks that the host runs itself falls back to its
        // own catalog, which restates each one's renderer danger (#13495).
        const declaredDanger = entry?.danger ?? viewlessActionDanger(actionId);
        const confirmGated =
          declaredDanger !== undefined &&
          resolveEffectiveActionDanger(actionId, declaredDanger, "agent", args) === "confirm";
        if (
          (dispatchAuthorization === undefined || dispatchAuthorization === "native-grant") &&
          confirmationsSkipped &&
          confirmGated
        ) {
          dispatchAuthorization = "skip-preference";
          dispatchConfirmed = true;
        }
        // A protected close already announced itself before asking (#12881);
        // an agent's close-all is confirm-gated by the effective danger.
        // A call under the skip preference never waits. Any other
        // preconfirmed call asks no one, except a force delete: the renderer
        // demotes one whose live tier is D3 back to the typed-name dialog
        // (#12115), and only it can read that tier, so the wait is announced.
        if (!toolCallStartedEmitted) {
          const danger = confirmGated && dispatchAuthorization !== "skip-preference";
          const mayDemoteToDialog =
            dispatchAuthorization !== "skip-preference" &&
            actionId === "worktree.delete" &&
            isForceDelete(args);
          emitToolCallStarted(danger, confirmGated && (!dispatchConfirmed || mayDemoteToDialog));
        }

        // The workspace the dispatch actually landed on, resolved renderer-side
        // at response time (#11536). Only ever set from a completed dispatch, so
        // every failure path below (no window, session binding gone, throw)
        // leaves it undefined and stamps nothing.
        let dispatchedWorkspace: DispatchedWorkspaceRef | undefined;

        /**
         * Collect every page of an `actions.list` match set. The renderer pages
         * before main can apply the tier filter (#11529), so filtering one of its
         * pages would return a short page whose `total`/`hasMore` counted actions
         * this session cannot dispatch. Walking the pages here lets the filter
         * page the *permitted* set instead, which keeps the contract coherent.
         * Entries carry no schemas, so this is a handful of cheap round trips.
         */
        const collectListPages = async (): Promise<DispatchEnvelope> => {
          const base = args && typeof args === "object" && !Array.isArray(args) ? args : {};
          const collected: unknown[] = [];
          let offset = 0;
          let confirmationDecision: DispatchEnvelope["confirmationDecision"];
          // The target is resolved once, before paging, so every page lands on
          // the same workspace — carrying the first page's ref out with the
          // synthesized envelope lets the caller stamp the paged result through
          // the same `withResolvedWorkspace` path the single-shot dispatch uses
          // (#11536). Skipping it would silently drop the field from exactly the
          // calls that walked more than one page.
          let pagedWorkspace: DispatchedWorkspaceRef | undefined;
          // The registry is a few hundred actions; the cap only stops a renderer
          // that never stops reporting `hasMore`.
          for (let page = 0; page < MAX_LIST_PAGE_WALK; page++) {
            const envelope = await dispatchAction(
              actionId,
              { ...(base as Record<string, unknown>), offset, limit: ACTIONS_LIST_MAX_LIMIT },
              dispatchConfirmed
            );
            confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
            pagedWorkspace = pagedWorkspace ?? envelope.dispatchedWorkspace;
            if (!envelope.result.ok) return envelope;
            const payload = envelope.result.result as
              { actions?: unknown; hasMore?: unknown } | null | undefined;
            if (!payload || !Array.isArray(payload.actions)) break;
            collected.push(...payload.actions);
            // Not stopped by an empty page: a Shell answering for this host
            // narrows each page to what a host may run (#13350), so one can
            // come back empty with more behind it.
            if (payload.hasMore !== true) break;
            offset += ACTIONS_LIST_MAX_LIMIT;
          }
          return {
            result: { ok: true, result: { actions: collected } },
            confirmationDecision,
            ...(pagedWorkspace ? { dispatchedWorkspace: pagedWorkspace } : {}),
          };
        };

        // The incarnation each named close reaches, read before it is sent: a
        // successor launched under the id while the close is out is not the
        // process the caller closed (#15728).
        // `terminal.closeAll` names none, so every tracked id is read instead;
        // a closed id missing from the read is noted with no incarnation.
        const closeGenerations = new Map<string, number | undefined>();
        if (CLOSE_TOOLS.has(actionId)) {
          const named =
            actionId === "terminal.closeAll"
              ? (deps.trackedTerminalIds?.() ?? [])
              : namedTerminalIds(args);
          for (const terminalId of named) {
            closeGenerations.set(terminalId, deps.terminalGenerationOf?.(terminalId));
          }
        }

        // An assistant target runs in main (#13496), with the notice and the
        // reply wait set up above around it like any send. Its refusals are
        // its own words, and a refused send cancels the notice in `finally`.
        // A global steer runs the same way, so its notice and reply wait are set
        // up around it, and nothing it refuses falls back to the renderer.
        let assistantEnvelope: DispatchEnvelope | undefined;
        if (
          (assistantTarget !== undefined && assistantCaller !== null && assistantControl) ||
          (globalSteerTerminalId !== undefined && globalRevealTerminalId === undefined)
        ) {
          try {
            const result =
              globalSteerTerminalId !== undefined
                ? await runGlobalSteer(globalSteerTerminalId)
                : await runAssistantTarget(assistantTarget!, assistantCaller!);
            assistantEnvelope = { result: { ok: true, result } };
          } catch (err) {
            if (err instanceof AssistantTargetError) {
              outcome = {
                kind: "result",
                value: {
                  ok: false,
                  error: { code: auditCodeForAssistantRefusal(err.code), message: err.message },
                },
              };
              return buildToolError({ code: err.code, message: err.message });
            }
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) throw err;
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // A retirement's teardown (#15737), after every gate that could still
        // refuse without changing anything, and right before the delete it
        // leads to. This session's panes in the worktree are closed as
        // `terminal.closeOwned` closes them, with the same release and closed
        // record, then their processes are waited for with their grace ended,
        // then the worktree is checked again: closing takes a while, and an
        // agent's last output can still dirty the tree. Nothing here asks the
        // user; the delete's own confirmation is the one question.
        if (retirement !== undefined) {
          const retiring = retirement;
          const closeEntry = OWNED_RESOURCE_TOOLS[
            "terminal.closeOwned"
          ] as RendererOwnedResourceTool;
          const dispatchClose = (id: string, closeArgs: unknown): Promise<DispatchEnvelope> =>
            relayCallId !== undefined
              ? dispatchAction(id, closeArgs, false, undefined, relayCallId)
              : dispatchAction(id, closeArgs, false);
          const torn = await tearDownForRetirement(retiring.worktreeId, retiring.plan, {
            signal: extra.signal,
            closePane: async ({ terminalId, launchGeneration }) => {
              const record = ownedRecordFor("terminal", terminalId);
              if (record === undefined) {
                return {
                  code: RESOURCE_NOT_OWNED_CODE,
                  message: `Pane '${terminalId}' is no longer this session's to close.`,
                };
              }
              // The run the checks found, and no other: a pane restarted
              // since then is a run they never looked at. Asked only when
              // both runs are known; otherwise the ledger answers alone, as
              // it does for `terminal.closeOwned`.
              const generation = deps.terminalGenerationOf?.(terminalId);
              if (
                launchGeneration !== undefined &&
                generation !== undefined &&
                generation !== launchGeneration
              ) {
                return {
                  code: "DISABLED",
                  message: `Pane '${terminalId}' was restarted after the checks, so it was not closed.`,
                };
              }
              const { envelope: dispatched } = await dispatchOwnedResource(
                {
                  sessionId,
                  actionId: "terminal.closeOwned",
                  args: { terminalId },
                  sessionStore,
                  ownershipOwner,
                  adoptedRecordFor,
                  admittedAdoption: undefined,
                  dispatchToRenderer: dispatchClose,
                  dispatchConfirmed: false,
                  revealOwnedRun: deps.revealOwnedRun,
                },
                closeEntry,
                terminalId
              );
              const closed: DispatchEnvelope =
                readClosedPanelProcess !== undefined
                  ? {
                      ...dispatched,
                      result: await withClosedPanelProcesses(
                        dispatched.result,
                        readClosedPanelProcess
                      ),
                    }
                  : dispatched;
              recordOwnershipFromDispatch(
                { sessionId, actionId: "terminal.closeOwned", sessionStore, ownershipOwner },
                {
                  ownedResource: closeEntry,
                  ownedResourceId: terminalId,
                  ownedResourceRecord: record,
                },
                closed
              );
              noteClosedTerminals(
                { sessionId, sessionStore, ownershipOwner },
                closed,
                () => generation
              );
              if (!closed.result.ok) return closed.result.error;
              if (!closedIdsInclude(closed.result.result, terminalId)) {
                return {
                  code: EXECUTION_ERROR_CODE,
                  message: `Closing pane '${terminalId}' reported nothing closed.`,
                };
              }
              return undefined;
            },
            waitForExits: async (terminalIds) => {
              const closedRecords = terminalIds.map((terminalId) => ({
                terminalId,
                record: sessionStore.resourceOwnership.closedRecord(ownershipOwner, terminalId),
              }));
              const closedIn = new Set(closedRecords.map(({ record }) => record?.workspaceId));
              const refusalOf = (refusal: { code: string; message: string }): ActionError => ({
                code: refusal.code as ActionError["code"],
                message: refusal.message,
              });
              const early = graceWriteRefusal(closedIn);
              if (early) return { error: refusalOf(early) };
              try {
                const result = await waitForClosedPanelExits!(
                  closedRecords.map(({ terminalId, record }) => ({
                    terminalId,
                    launchGeneration: record?.launchGeneration,
                  })),
                  {
                    timeoutMs: retiring.timeoutMs,
                    endGrace: true,
                    signal: extra.signal,
                    authorizeEndGrace: () => {
                      const late = graceWriteRefusal(closedIn);
                      if (late) throw new RelayWriteRefused(late);
                    },
                  }
                );
                return { result };
              } catch (err) {
                if (err instanceof RelayWriteRefused) return { error: refusalOf(err.refusal) };
                throw err;
              }
            },
            recheck: async () => {
              // The record the call was admitted on, by identity: a worktree
              // deleted and recreated at the path since is another worktree.
              if (ownedRecordFor("worktree", retiring.worktreeId) !== ownedResourceRecord) {
                return {
                  code: RESOURCE_NOT_OWNED_CODE,
                  message: `Worktree '${retiring.worktreeId}' is no longer this session's to delete.`,
                };
              }
              let git: WorktreeGitObservation;
              try {
                git = await deps.readWorktreeGit!(retiring.worktreeId, extra.signal);
              } catch {
                return gitUnreadableRefusal(retiring.worktreeId);
              }
              const unclean = refuseUnlessCleanAndPushed(retiring.worktreeId, git);
              if (unclean !== undefined || git.headOid === null) {
                return unclean ?? gitUnreadableRefusal(retiring.worktreeId);
              }
              retiring.git = { ...git, headOid: git.headOid };
              return refuseWorktreeDeleteWhileRunning(
                retiring.worktreeId,
                deps.readTerminalProcesses,
                attributeWorktreeTerminal
              );
            },
          });
          if (!torn.ok) {
            outcome = { kind: "result", value: { ok: false, error: torn.error } };
            return buildToolError(torn.error);
          }
          retiring.progress = torn.progress;
        }

        // The answer for a dispatch that threw, shared by the plain reply and
        // a retirement's cause so the two never classify one error apart.
        const dispatchFailure = (
          err: unknown
        ): { error: Parameters<typeof buildToolError>[0]; confirmationPending: boolean } => {
          // Checked before the binding failure it extends: the workspace is
          // reachable in principle, it just has nothing attached that could run
          // this action, and the host has no form of it to run alone.
          if (err instanceof NoFrontendAttachedError) {
            const statusHint =
              actionId === TERMINAL_GET_STATUS_TOOL
                ? ` Status for specific terminals can still be read without one — call '${actionId}' again with an explicit 'terminalIds' array.`
                : "";
            return {
              error: {
                code: NO_FRONTEND_ATTACHED_CODE,
                message: `${err.message}${statusHint}`,
                retriable: true,
              },
              confirmationPending: false,
            };
          }
          if (err instanceof RelayDrivenElsewhereError) {
            return { error: { code: err.code, message: err.message }, confirmationPending: false };
          }
          if (err instanceof McpRouteBindingError) {
            return {
              error: {
                code: bindingGoneCode(err),
                message: err.message,
                // Instance-derived: a workspace the user can reopen is retriable,
                // a destroyed pinned view never is, and both report this code.
                retriable: err.retriable,
              },
              confirmationPending: false,
            };
          }
          // No live renderer to route the dispatch through (#10640). Every
          // unconfirmed `danger: "confirm"` dispatch is forwarded to the
          // renderer bridge so the human can approve it in a native
          // ConfirmDialog (#11342); with no Daintree window open,
          // `getActiveProjectWebContents` throws `RendererBridgeUnavailableError`.
          if (err instanceof RendererBridgeUnavailableError) {
            // Confirm-gated tool we KNOW needs human approval (manifest entry
            // resolved): the action could not be confirmed, not that it failed
            // mid-execution. Reclassify to CONFIRMATION_REQUIRED (audited as
            // `confirmation-pending`, never retriable) with a machine-readable
            // `confirmationChannel: "unavailable"` so an autonomous conductor
            // can tell "needs a human I can't reach" apart from a transient
            // error. Scoped to unconfirmed dispatches so an already-approved
            // call that fails for any other reason isn't mislabelled.
            if (entry?.danger === "confirm" && !dispatchConfirmed) {
              return {
                error: {
                  code: CONFIRMATION_REQUIRED_CODE,
                  message:
                    `Action '${actionId}' requires confirmation, but no Daintree window is open to surface the ` +
                    `approval dialog. The action was not run — a human must approve it in Daintree.`,
                  details: { confirmationChannel: "unavailable" },
                },
                confirmationPending: true,
              };
            }
            // Either a non-confirm tool, or a cold-cache call whose manifest
            // entry couldn't be fetched (the manifest itself comes from the
            // renderer, so `entry` is undefined here and the tool's danger is
            // unknowable). We must not claim CONFIRMATION_REQUIRED without
            // knowing the tool is confirm-gated. With Host-mode routing this is
            // the typed, retriable "no frontend" refusal — a window may open,
            // locally or from another machine; an unbound session names no
            // workspace, so there is no project the host could run the action
            // for on its own. Without it, the retriable EXECUTION_ERROR this
            // has always been.
            const message =
              "No Daintree window is open, so the action surface is unavailable. Retry once a project window is open.";
            return {
              error: isMcpHostRoutingEnabled()
                ? { code: NO_FRONTEND_ATTACHED_CODE, message, retriable: true }
                : { code: EXECUTION_ERROR_CODE, message },
              confirmationPending: false,
            };
          }
          return {
            error: {
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "Action dispatch failed"),
            },
            confirmationPending: false,
          };
        };

        try {
          // An `*Owned` tool that cleared the gate above delegates to the real
          // action under its own id, with arguments rebuilt from scratch rather
          // than forwarded (#11909). Rebuilding is the enforcement: the renderer
          // validates against `worktree.delete`'s schema, which still accepts
          // `force`, `deleteBranch` and `closeTerminals`, so anything the caller
          // sent beyond the id would otherwise pass straight through the
          // narrower tool that deliberately omits them. It is also what lets a
          // delegate spell the id differently — `pilot.openRun` takes `runId`
          // where the public tool takes `terminalId` (#12315).
          // `raised` answers the second half of a reveal — whether a window
          // actually came forward — and is vacuously true for everything else.
          // A global Assistant's reveal of a worker it didn't launch (#16096)
          // is the owned reveal's dispatch, sent only once the steer's gate
          // has let the run it names through, and answered the same way.
          const { envelope: dispatched, raised } = assistantEnvelope
            ? { envelope: assistantEnvelope, raised: true }
            : globalRevealTerminalId !== undefined
              ? await deps.globalSteer!.reveal(globalSteerTarget(globalRevealTerminalId), () =>
                  dispatchOwnedResourceAction(
                    ownedResource as RendererOwnedResourceTool,
                    globalRevealTerminalId!
                  )
                )
              : listPaging ||
                  ownedResource?.executor !== "renderer" ||
                  ownedResourceId === undefined
                ? {
                    envelope: listPaging
                      ? await collectListPages()
                      : await dispatchToRenderer(actionId, dispatchArgs),
                    raised: true,
                  }
                : await dispatchOwnedResourceAction(ownedResource, ownedResourceId);
          // A close trashes the panel and its process runs on through the
          // grace, so the answer says what the host saw of each one (#14474).
          // Every route a close takes ends here: renderer, viewless, owned,
          // an assistant's, and each item of `terminal.closeMany`.
          const envelope: DispatchEnvelope =
            readClosedPanelProcess !== undefined && CLOSE_TOOLS.has(actionId)
              ? {
                  ...dispatched,
                  result: await withClosedPanelProcesses(dispatched.result, readClosedPanelProcess),
                }
              : dispatched;
          // Narrow renderer-computed results against this session before
          // anything downstream reads them: the effective action surface for
          // the registry-enumerating tools (#11525), and the ownership ledger
          // for an `owned` listing (#12308). Both narrow on session state the
          // renderer has no access to, and both are placed ahead of the
          // `outcome` assignment so the text content, the structuredContent
          // block, and the audit record all observe one filtered value — and so
          // both the pinned and unpinned dispatch paths, which converge on this
          // call, are covered by the same gate.
          outcome = {
            kind: "result",
            value: introspectionSurface
              ? filterIntrospectionResultForSession(
                  actionId,
                  envelope.result,
                  introspectionSurface.permittedActionIds,
                  introspectionSurface
                )
              : ownedOnly
                ? filterTerminalListToOwned(envelope.result, drivesTerminal)
                : envelope.result,
          };
          // Ownership bookkeeping, from the envelope the action actually
          // returned rather than from anything the caller said (#11909).
          // Reads `envelope.result`, not `outcome.value`: the filters above
          // rewrite results for the discovery tools and for an `owned`
          // listing, and the ledger must observe the unnarrowed truth.
          // Recorded for every tier
          // — "this session created it" is a fact about the session, not about
          // its privileges.
          recordDispatchOwnership(envelope);
          // What it closed, so it can wait for those processes to exit after
          // `terminal.closeOwned` released them (#15728).
          if (CLOSE_TOOLS.has(actionId)) {
            noteClosedTerminals({ sessionId, sessionStore, ownershipOwner }, envelope, (id) =>
              closeGenerations.get(id)
            );
          }
          settleRestartHold?.(envelope.result.ok);
          settleRestartHold = undefined;
          // Hand the notice what the action reported: the send's submission
          // token or the launch's terminal id. A failed dispatch drops it —
          // the caller already has the error.
          if (pendingNotify !== undefined) {
            const follow = pendingNotify;
            pendingNotify = undefined;
            if (envelope.result.ok) follow.complete(envelope.result.result);
            else follow.cancel();
          } else if (
            envelope.result.ok &&
            NOTIFY_PROMPT_TOOLS.has(actionId) &&
            terminalNotify !== undefined &&
            tier !== "external"
          ) {
            // A prompt without `notify` still makes the pane's undelivered
            // notice about the target stale: typed after this prompt, it
            // would read as the answer to it.
            const pane = ownPane();
            const targetId = ownedResourceId ?? readStringArg(args, "terminalId");
            if (pane !== null && targetId !== undefined) terminalNotify.supersede(pane, targetId);
          }
          confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
          // A relayed call the Shell ran under its own assistant's "Never ask"
          // (#15698): that, not an unasked run, is what its audit says. Only a
          // relayed session's: no other caller's view speaks for its preference.
          if (
            relayCallId !== undefined &&
            dispatchAuthorization === undefined &&
            envelope.authorization === "skip-preference"
          ) {
            dispatchAuthorization = "skip-preference";
          }
          // "Allow for this session" on the ordinary confirm dialog of a pane's
          // own-tier tool (#12692). The bridge only reports the scope for an
          // approval that offered it; the pane check here is the one that
          // matters.
          if (
            paneApproval &&
            envelope.confirmationDecision === "approved" &&
            envelope.approvalScope === "session"
          ) {
            mintSessionApproval();
          }
          dispatchedWorkspace = envelope.dispatchedWorkspace;
          // A raise that did not happen is reported, not swallowed (#12315).
          // The tool's whole promise is that the user ends up looking at the
          // panel; a client told "revealed" when no window came forward has no
          // way to know it should tell them where the run is instead.
          //
          // Placed after the ledger bookkeeping above so the panel stays this
          // session's: a reveal the user missed is not a disposal, and the
          // obvious next move is to ask for it again.
          if (!raised && envelope.result.ok) {
            const message =
              `The switch to '${ownedResourceId ?? actionId}' was accepted, but no Daintree ` +
              `window could be brought to the front, so the user may not be looking at it. ` +
              `Tell them where the run is rather than assuming they can see it.`;
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: "EXECUTION_ERROR", message } },
            };
            return buildToolError({ code: "EXECUTION_ERROR", message });
          }
        } catch (err) {
          // The steer's gate refusing a reveal (#16096): its own words, as a
          // refused steer's are.
          if (globalRevealTerminalId !== undefined && err instanceof AssistantTargetError) {
            outcome = {
              kind: "result",
              value: {
                ok: false,
                error: { code: auditCodeForAssistantRefusal(err.code), message: err.message },
              },
            };
            return buildToolError({ code: err.code, message: err.message });
          }
          outcome = { kind: "throw", error: err };
          const failure = dispatchFailure(err);
          // A retirement that already closed panes says so whatever the
          // delete threw, so a caller never sees a bare failure that hides
          // what changed (#15737). The cause is the plain answer below.
          if (
            retirement?.progress !== undefined &&
            retirementChangedSomething(retirement.progress)
          ) {
            const error = retirementStopped(retirement.worktreeId, "delete", retirement.progress, {
              code: failure.error.code as ActionError["code"],
              message: failure.error.message,
              ...(failure.error.details !== undefined ? { details: failure.error.details } : {}),
            });
            outcome = { kind: "result", value: { ok: false, error } };
            return buildToolError(error);
          }
          if (failure.confirmationPending) {
            outcome = {
              kind: "result",
              value: {
                ok: false,
                error: {
                  code: CONFIRMATION_REQUIRED_CODE,
                  message: failure.error.message,
                  details: failure.error.details,
                },
              },
            };
          }
          return buildToolError(failure.error);
        }

        // A retirement answers for the whole call (#15737): what it closed and
        // saw exit once the delete succeeded, and what it had already done
        // when the delete did not.
        if (retirement?.progress !== undefined) {
          outcome = {
            kind: "result",
            value: outcome.value.ok
              ? {
                  ok: true,
                  result: retirementResult(
                    retirement.worktreeId,
                    retirement.progress,
                    retirement.git
                  ),
                }
              : {
                  ok: false,
                  error: retirementStopped(
                    retirement.worktreeId,
                    "delete",
                    retirement.progress,
                    outcome.value.error
                  ),
                },
          };
        }

        if (outcome.value.ok) {
          // Sliding-TTL refresh: a successful dispatch through a grant
          // extends its window AND resets the session idle timer. Without
          // resetting the idle timer, a 15-min grant could be silently
          // truncated by a 30-min idle reaper that started before the
          // grant was issued (#8442). The `grantIssuedAt` token guards
          // against a revoke-and-reissue race (#2243): if the entry was
          // replaced mid-dispatch, `refresh` is a silent no-op.
          if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
            if (grantIssuedAt !== undefined) {
              sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
            }
            if (nativeGrantId !== undefined) {
              sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
            }
            if (sessionStore.sessions.has(sessionId)) {
              sessionStore.resetIdleTimer(sessionId);
            } else if (sessionStore.httpSessions.has(sessionId)) {
              sessionStore.resetHttpIdleTimer(sessionId);
            }
          }
          if (isImageResultTool(actionId)) {
            return withResolvedWorkspace(
              buildImageToolCallResult(outcome.value.result),
              dispatchedWorkspace
            );
          }
          const structuredContent = buildStructuredContent(entry, outcome.value.result);
          return withResolvedWorkspace(
            buildToolCallResult(outcome.value.result, {
              ...(structuredContent ? { structuredContent } : {}),
            }),
            dispatchedWorkspace
          );
        }

        // A renderer was reached, so the target is known and worth reporting —
        // unlike the pre-dispatch errors above. The failure is usually the
        // renderer's own, but an `owned` listing main could not read fails
        // here too (#12308), after a dispatch that itself succeeded.
        return withResolvedWorkspace(
          buildToolError({
            code: outcome.value.error.code,
            message: outcome.value.error.message,
            details: outcome.value.error.details,
          }),
          dispatchedWorkspace
        );
      } finally {
        pendingNotify?.cancel();
        pendingNotify = undefined;
        settleRestartHold?.(false);
        settleRestartHold = undefined;
        settleCall({ appendAuditRecord, notifyToolCallSettled }, facts, {
          outcome,
          confirmationDecision,
          dispatchAuthorization,
          started: toolCallStartedEmitted
            ? { danger: toolCallStartedDanger, asks: toolCallStartedAsks }
            : undefined,
        });
      }
    })();

    // A waited call's answer is the dispatch plus its reply, so that is what a
    // duplicate shares and what the cache keeps: never a bare receipt.
    const repliedPromise: Promise<CallToolResultLike> =
      replyWait === undefined
        ? dispatchPromise
        : dispatchPromise.then((result) =>
            attachReply(result as CallToolResult, replyWait!, releaseNotice)
          );
    // An api-key client learns its ownership is session-scoped from what it
    // creates, before a refusal tells it (#12987). A trailing text block, so
    // the declared result and `content[0]` are untouched; added after the
    // reply, which rebuilds the result, and before the cache keeps it, so a
    // duplicate reads it too.
    const notesOwnership =
      sessionScopedOwner &&
      (actionId === AGENT_LAUNCH_TOOL ||
        actionId === "agent.launchMany" ||
        actionId === AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL ||
        (actionId === "terminal.list" && ownedOnly));
    const answerPromise: Promise<CallToolResultLike> = notesOwnership
      ? repliedPromise.then((result) =>
          result.isError === true || outcome?.kind !== "result" || !outcome.value.ok
            ? result
            : {
                ...result,
                content: [
                  ...result.content,
                  { type: "text" as const, text: SESSION_OWNERSHIP_NOTE },
                ],
              }
        )
      : repliedPromise;

    if (dedupKey !== undefined) {
      registerCallDedup(
        sessionStore,
        sessionId,
        dedupKey,
        argsHash!,
        answerPromise,
        // The one-call launch's partial answer is kept as well: it names a
        // worktree that exists, and a retry run again would make another.
        () =>
          outcome?.kind === "result" &&
          (outcome.value.ok ||
            (actionId === AGENT_LAUNCH_IN_NEW_WORKTREE_TOOL &&
              outcome.value.error.code === "PARTIAL_SUCCESS"))
      );
    }

    return (await answerPromise) as CallToolResult;
  };
  server.setRequestHandler(CallToolRequestSchema, handleCallTool);

  registerResourceHandlers(server, session, deps);
  registerPromptHandlers(server, session, deps);

  return server;
}
