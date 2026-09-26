import { z } from "zod";
import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import type { McpBearerIdentity } from "../../../shared/types/ipc/mcpServer.js";
import {
  MCP_DISPATCH_ACTION_METHOD,
  MCP_GET_MANIFEST_METHOD,
} from "../../services/mcp-server/driveTarget.js";
import { AppError } from "../../utils/errorTypes.js";
import { NOTIFICATION_SHOW_METHOD, showHostNotification } from "../hybrid/notifications.js";
import { getRemoteService } from "../runtime.js";
import { HOST_DISPATCHABLE_ACTION_IDS } from "./hostDispatchableActions.js";
import { registerReverseRequestMethod } from "./reverseRequests.js";

export { HOST_DISPATCHABLE_ACTION_IDS };

/**
 * What a host's MCP server sends the view that drives its project. Only the
 * action and its arguments are taken from it. Everything that would stand in
 * for this Shell's own judgement is read and then ignored: `confirmed` (a host
 * cannot approve for the person at this screen), `context` (the view's own
 * binding says which project and worktree), `sessionOrigin` (a host's session
 * is never one of this Shell's assistant surfaces) and `offerSessionApproval`
 * (an approval this Shell would not honour on the next call).
 */
const McpDispatchPayloadSchema = z.object({
  actionId: z.string().min(1).max(256),
  args: z.unknown(),
  confirmed: z.boolean(),
  context: z.record(z.string(), z.unknown()).optional(),
  sessionOrigin: z.enum(["help", "assistant-pane", "external"]),
  offerSessionApproval: z.boolean().optional(),
  approvalOnly: z.boolean().optional(),
});

export function isHostDispatchableAction(actionId: string): boolean {
  return HOST_DISPATCHABLE_ACTION_IDS.has(actionId);
}

async function loadMcpServerService() {
  // Loaded on first use: most Shells are never asked, and the service is heavy.
  const { mcpServerService } = await import("../../services/McpServerService.js");
  return mcpServerService;
}

/** The host as the person at this screen knows it, for the confirm dialog's "Requested by" row. */
function describeHost(hostId: string): McpBearerIdentity {
  let name = hostId;
  try {
    const entry = getRemoteService("remoteHostsClient")
      ?.list()
      .find((candidate) => candidate.descriptor.id === hostId);
    if (entry) name = entry.descriptor.name;
  } catch {
    // The id is still an honest name.
  }
  return { userAgent: `Agent on host "${name}"`, token4LastChars: hostId.slice(-4) };
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
  // Never pre-confirmed: a confirm-gated action raises this Shell's own dialog,
  // naming the host that asked, exactly as a local MCP client's would.
  const envelope = await service.dispatchActionForHost(
    webContentsId,
    request.actionId,
    request.args,
    false,
    undefined,
    "external",
    request.approvalOnly ? { approvalOnly: true } : undefined,
    describeHost(hostId)
  );
  // Only what the host reads back: this machine's view identity stays here,
  // and no approval is ever handed out for the host to reuse.
  return {
    result: envelope.result,
    ...(envelope.confirmationDecision !== undefined
      ? { confirmationDecision: envelope.confirmationDecision }
      : {}),
  };
}

async function requestManifest(webContentsId: number): Promise<ActionManifestEntry[]> {
  const manifest = await (await loadMcpServerService()).requestManifestForHost(webContentsId);
  return manifest.filter((entry) => isHostDispatchableAction(entry.id));
}

/**
 * The reverse requests a host may send this Shell's views: MCP dispatch and
 * manifest reads for the view that drives a project, and notifications the
 * host decided to show. Returns a teardown.
 */
export function installViewReverseRequests(): () => void {
  const disposers = [
    registerReverseRequestMethod(MCP_DISPATCH_ACTION_METHOD, ({ hostId, webContentsId, payload }) =>
      dispatchAction(hostId, webContentsId, payload)
    ),
    registerReverseRequestMethod(MCP_GET_MANIFEST_METHOD, ({ webContentsId }) =>
      requestManifest(webContentsId)
    ),
    registerReverseRequestMethod(NOTIFICATION_SHOW_METHOD, ({ webContentsId, payload }) => {
      if (!showHostNotification(webContentsId, payload)) {
        throw new AppError({ code: "VALIDATION", message: "Malformed notification from the host" });
      }
      return null;
    }),
  ];
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
}
