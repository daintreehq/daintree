import { z } from "zod";
import type { ActionDispatchResult, ActionManifestEntry } from "../../../shared/types/actions.js";
import type {
  McpBearerIdentity,
  McpConfirmationDecision,
} from "../../../shared/types/ipc/mcpServer.js";
import type { RelayApprovalQuestion } from "../assistant/HostCallRuntime.js";
import {
  MCP_DISPATCH_ACTION_METHOD,
  MCP_GET_MANIFEST_METHOD,
} from "../../services/mcp-server/driveTarget.js";
import { LOCAL_HOST_ID, parseHostScopedKey } from "../../../shared/types/remoteHosts.js";
import { getProjectForWebContents } from "../../window/webContentsRegistry.js";
import { resolveEffectiveActionDanger } from "../../../shared/utils/effectiveActionDanger.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  NOTIFICATION_CLOSE_METHOD,
  NOTIFICATION_RECONCILE_METHOD,
  NOTIFICATION_SHOW_METHOD,
  closeHostNotifications,
  reconcileHostNotifications,
  showHostNotification,
} from "../hybrid/notifications.js";
import { getRemoteService } from "../runtime.js";
import {
  HOST_ALWAYS_ASKS_ACTION_IDS,
  HOST_DISPATCHABLE_ACTION_IDS,
} from "./hostDispatchableActions.js";
import { registerReverseRequestMethod } from "./reverseRequests.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:viewRequests");

export { HOST_DISPATCHABLE_ACTION_IDS };

/**
 * What a host's MCP server sends the view that drives its project. Only the
 * action and its arguments are taken from it. Everything that would stand in
 * for this Shell's own judgement is read and then ignored: `confirmed` (a host
 * cannot approve for the person at this screen), `context` (the view's own
 * binding says which project and worktree), `sessionOrigin` (a host's session
 * is never one of this Shell's assistant surfaces) and `offerSessionApproval`
 * (an approval this Shell would not honour on the next call).
 *
 * One exception (#13368): the assistant's confirmations preference is
 * host-owned, so only the host can say a call falls under "Never ask". A call
 * the host confirmed for its own assistant under `skip-preference` runs
 * without this Shell's dialog — see `honoursSkipPreference`. This Shell's own
 * assistant's call through `host.call` follows this Shell's own preference
 * instead (#15698) — see `skipsOwnRelayedCall`.
 */
const McpDispatchPayloadSchema = z.object({
  actionId: z.string().min(1).max(256),
  args: z.unknown(),
  confirmed: z.boolean(),
  context: z.record(z.string(), z.unknown()).optional(),
  sessionOrigin: z.enum(["help", "external"]),
  offerSessionApproval: z.boolean().optional(),
  approvalOnly: z.boolean().optional(),
  // Which approval dialog an `approvalOnly` request raises. It picks the
  // dialog's shape (a protected close lists the panels to tick), never whether
  // one is shown, so it is taken as-is.
  approvalReason: z.enum(["above-tier", "protected-close"]).optional(),
  authorization: z.string().max(64).optional(),
  // This Shell's own assistant asked, through `host.call` (#13493). Display
  // only, and believed only while this Shell has a call out to that host: it
  // names who asked in the dialog and grants nothing.
  relayed: z.boolean().optional(),
  // Which of this Shell's own `host.call`s the host is running (#15698).
  // Grants nothing by itself: it names a call for this Shell to look up, and
  // only a call still out to that host, about exactly this action and these
  // arguments, from an assistant whose confirmations are skipped here, runs
  // without asking.
  relayCall: z
    .object({
      // The link's own bounds for both, so no call a host admitted is refused here.
      callId: z.string().min(1).max(256),
      helpSessionId: z.string().min(1).max(256),
    })
    .strict()
    .optional(),
});

type McpDispatchPayload = z.infer<typeof McpDispatchPayloadSchema>;

/**
 * Whether a host's dispatch carries its assistant's standing "Never ask"
 * (#12874), the one confirmation this Shell takes from a host. The host stamps
 * `skip-preference` only on its own assistant's calls (#13137), so an agent
 * pane or api-key client on the host still raises this Shell's dialog. An
 * approval-only request exists to ask, and a move of this window always does.
 */
function honoursSkipPreference(request: McpDispatchPayload): boolean {
  return (
    request.confirmed &&
    request.sessionOrigin === "help" &&
    request.authorization === "skip-preference" &&
    request.approvalOnly !== true &&
    !HOST_ALWAYS_ASKS_ACTION_IDS.has(request.actionId)
  );
}

/**
 * Whether a host's dispatch is one of this Shell's own assistant's relayed
 * calls that runs under that assistant's "Never ask" here (#15698): one this
 * view would ask about, matched to the call this Shell has out to that host,
 * in the project this view shows of it. The skip is read on this Shell; an
 * approval-only request exists to ask.
 */
async function skipsOwnRelayedCall(
  service: Awaited<ReturnType<typeof loadMcpServerService>>,
  hostId: string,
  webContentsId: number,
  request: McpDispatchPayload
): Promise<boolean> {
  const call = request.relayCall;
  if (call === undefined || request.approvalOnly === true) return false;
  const viewKey = getProjectForWebContents(webContentsId);
  if (viewKey === null) return false;
  const view = parseHostScopedKey(viewKey);
  if (view.hostId !== hostId) return false;
  // A call that wouldn't ask has no confirmation to skip, and its record
  // mustn't say it ran unasked.
  if (!(await asksInView(service, webContentsId, request))) return false;
  return (
    getRemoteService("hostCallRelayClient")?.skipsRelayedDispatch(hostId, {
      callId: call.callId,
      helpSessionId: call.helpSessionId,
      projectId: view.projectId,
      actionId: request.actionId,
      args: request.args,
    }) === true
  );
}

/** Whether this view raises a confirmation for the dispatch, by its own registry's danger. */
async function asksInView(
  service: Awaited<ReturnType<typeof loadMcpServerService>>,
  webContentsId: number,
  request: McpDispatchPayload
): Promise<boolean> {
  let manifest: ActionManifestEntry[];
  try {
    manifest = await service.requestManifestForHost(webContentsId);
  } catch (error) {
    logger.warn("Couldn't read the view's actions for a relayed call", { error });
    return false;
  }
  const entry = manifest.find((candidate) => candidate.id === request.actionId);
  return (
    entry?.danger !== undefined &&
    resolveEffectiveActionDanger(request.actionId, entry.danger, "agent", request.args) ===
      "confirm"
  );
}

export function isHostDispatchableAction(actionId: string): boolean {
  return HOST_DISPATCHABLE_ACTION_IDS.has(actionId);
}

async function loadMcpServerService() {
  // Loaded on first use: most Shells are never asked, and the service is heavy.
  const { mcpServerService } = await import("../../services/McpServerService.js");
  return mcpServerService;
}

/** What this device calls a host, or its id. */
function hostName(hostId: string): string {
  try {
    const entry = getRemoteService("remoteHostsClient")
      ?.list()
      .find((candidate) => candidate.descriptor.id === hostId);
    if (entry) return entry.descriptor.name;
  } catch {
    // The id is still an honest name.
  }
  return hostId;
}

/**
 * The host as the person at this screen knows it, for the confirm dialog's
 * "Requested by" row. No token suffix: no bearer of this machine's is involved,
 * and a slice of the host's id beside its name only repeated it. This
 * machine's own id is an assistant here working in another project (#14024).
 */
function describeHost(hostId: string, relayed: boolean): McpBearerIdentity {
  return {
    userAgent:
      hostId === LOCAL_HOST_ID
        ? "Your assistant, in another project here"
        : relayed
          ? `Your assistant, through host "${hostName(hostId)}"`
          : `Agent on host "${hostName(hostId)}"`,
    token4LastChars: "",
  };
}

function isHostDispatchableEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && isHostDispatchableAction(id);
}

/**
 * The registry reads answer from this view's whole action registry, which
 * knows nothing of hosts: narrowed to what a host may run, so a host's search
 * never turns up a tool its next call would be refused (#13350). Paging stays
 * the view's own, since the host walks `actions.list` by it page after page.
 */
function narrowRegistryRead(actionId: string, result: ActionDispatchResult): ActionDispatchResult {
  if (!result.ok || !result.result || typeof result.result !== "object") return result;
  const payload = result.result as Record<string, unknown>;
  if (actionId === "actions.list" && Array.isArray(payload.actions)) {
    return {
      ...result,
      result: { ...payload, actions: payload.actions.filter(isHostDispatchableEntry) },
    };
  }
  if (actionId === "actions.search" && Array.isArray(payload.results)) {
    const results = payload.results.filter(isHostDispatchableEntry);
    return { ...result, result: { ...payload, totalMatches: results.length, results } };
  }
  if (
    actionId === "actions.getSchema" &&
    payload.entry &&
    !isHostDispatchableEntry(payload.entry)
  ) {
    return {
      ...result,
      result: {
        ok: false,
        entry: null,
        policy: null,
        error: {
          code: "NOT_FOUND",
          message: "No action found with that id. Use actions.search to find available actions.",
        },
      },
    };
  }
  return result;
}

async function dispatchAction(
  hostId: string,
  webContentsId: number,
  payload: unknown
): Promise<unknown> {
  const parsed = McpDispatchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError({ code: "VALIDATION", message: "Malformed MCP dispatch from the host" });
  }
  const request = parsed.data;
  if (!isHostDispatchableAction(request.actionId)) {
    // Answered as a result, not a transport failure, so the host's agent reads
    // it as the refusal it is rather than a link that went away.
    return {
      result: {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Action '${request.actionId}' cannot be run from a remote host.`,
        },
      },
    };
  }
  const service = await loadMcpServerService();
  // Otherwise never pre-confirmed: a confirm-gated action raises this Shell's
  // own dialog, naming the host that asked, exactly as a local MCP client's
  // would. The origin stays `external` either way: the skip rides on
  // `authorization`, not on posing as one of this Shell's assistant surfaces.
  const hostSkip = honoursSkipPreference(request);
  const ownSkip = !hostSkip && (await skipsOwnRelayedCall(service, hostId, webContentsId, request));
  const skipPreference = hostSkip || ownSkip;
  const envelope = await service.dispatchActionForHost(
    webContentsId,
    request.actionId,
    request.args,
    skipPreference,
    undefined,
    "external",
    // The host times this call, so this view never holds it open past the
    // host's own deadline, which is the one its agent is told about (#14989).
    skipPreference
      ? { authorization: "skip-preference", fixedDeadline: true }
      : request.approvalOnly
        ? {
            approvalOnly: true,
            ...(request.approvalReason ? { approvalReason: request.approvalReason } : {}),
            fixedDeadline: true,
          }
        : { fixedDeadline: true },
    describeHost(
      hostId,
      request.relayed === true &&
        getRemoteService("hostCallRelayClient")?.hasCallInFlight(hostId) === true
    )
  );
  // Only what the host reads back: this machine's view identity stays here,
  // and no approval is ever handed out for the host to reuse. A skip this
  // Shell granted is said, so the host's audit doesn't read it as unasked; a
  // dialog raised after all (a force delete's typed name) says what happened.
  return {
    result: narrowRegistryRead(request.actionId, envelope.result),
    ...(envelope.confirmationDecision !== undefined
      ? { confirmationDecision: envelope.confirmationDecision }
      : ownSkip
        ? { authorization: "skip-preference" }
        : {}),
  };
}

/**
 * Put a host's question about one of this Shell's relayed calls to the person
 * in this window (#13501): the dialog the action raises here, naming the host
 * it came through and showing that host's own preview of the call, which
 * dispatches nothing. The decision, or null when this window couldn't ask.
 */
export async function askHostApprovalInWindow(
  webContentsId: number,
  ask: RelayApprovalQuestion
): Promise<McpConfirmationDecision | null> {
  const service = await loadMcpServerService();
  try {
    const envelope = await service.dispatchActionForHost(
      webContentsId,
      ask.actionId,
      ask.args,
      false,
      undefined,
      "external",
      {
        approvalOnly: true,
        hostPreview: { lines: ask.lines, ...(ask.subject ? { subject: ask.subject } : {}) },
        // The host's own approval window governs a call it runs itself.
        fixedDeadline: true,
      },
      describeHost(ask.hostId, true)
    );
    return envelope.confirmationDecision ?? null;
  } catch (error) {
    logger.warn("Couldn't ask about a host's call in its assistant's window", { error });
    return null;
  }
}

/**
 * Put one of this machine's assistants' host settings changes to the person in
 * that assistant's window (#14167): the dialog `host.settings` raises, showing
 * the preview this Shell read from every host it names, which dispatches
 * nothing. The decision, or null when this window couldn't ask.
 */
export async function askSettingsApprovalInWindow(
  webContentsId: number,
  ask: { actionId: string; args: Record<string, unknown>; subject: string; lines: string[] }
): Promise<McpConfirmationDecision | null> {
  const service = await loadMcpServerService();
  try {
    const envelope = await service.dispatchActionForHost(
      webContentsId,
      ask.actionId,
      ask.args,
      false,
      undefined,
      "external",
      { approvalOnly: true, hostPreview: { lines: ask.lines, subject: ask.subject } },
      { userAgent: "Your assistant, here", token4LastChars: "" }
    );
    return envelope.confirmationDecision ?? null;
  } catch (error) {
    logger.warn("Couldn't ask about a host settings change in its assistant's window", { error });
    return null;
  }
}

async function requestManifest(webContentsId: number): Promise<ActionManifestEntry[]> {
  const manifest = await (await loadMcpServerService()).requestManifestForHost(webContentsId);
  return manifest.filter((entry) => isHostDispatchableAction(entry.id));
}

/**
 * The reverse requests a host may send this Shell's views: MCP dispatch and
 * manifest reads for the view that drives a project, and notifications the
 * host decided to show or take down. Returns a teardown.
 */
export function installViewReverseRequests(): () => void {
  const disposers = [
    registerReverseRequestMethod(MCP_DISPATCH_ACTION_METHOD, ({ hostId, webContentsId, payload }) =>
      dispatchAction(hostId, webContentsId, payload)
    ),
    registerReverseRequestMethod(MCP_GET_MANIFEST_METHOD, ({ webContentsId }) =>
      requestManifest(webContentsId)
    ),
    registerReverseRequestMethod(NOTIFICATION_SHOW_METHOD, ({ hostId, webContentsId, payload }) => {
      if (!showHostNotification(webContentsId, payload, { id: hostId, name: hostName(hostId) })) {
        throw new AppError({ code: "VALIDATION", message: "Malformed notification from the host" });
      }
      return null;
    }),
    registerReverseRequestMethod(NOTIFICATION_CLOSE_METHOD, ({ hostId, payload }) => {
      if (!closeHostNotifications(payload, hostId)) {
        throw new AppError({
          code: "VALIDATION",
          message: "Malformed notification close from the host",
        });
      }
      return null;
    }),
    registerReverseRequestMethod(
      NOTIFICATION_RECONCILE_METHOD,
      ({ hostId, webContentsId, payload }) => {
        if (!reconcileHostNotifications(webContentsId, payload, hostId)) {
          throw new AppError({
            code: "VALIDATION",
            message: "Malformed notification reconcile from the host",
          });
        }
        return null;
      }
    ),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
