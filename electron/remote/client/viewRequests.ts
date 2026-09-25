import { z } from "zod";
import type { ActionContext } from "../../../shared/types/actions.js";
import {
  MCP_DISPATCH_ACTION_METHOD,
  MCP_GET_MANIFEST_METHOD,
} from "../../services/mcp-server/driveTarget.js";
import { AppError } from "../../utils/errorTypes.js";
import { NOTIFICATION_SHOW_METHOD, showHostNotification } from "../hybrid/notifications.js";
import { registerReverseRequestMethod } from "./reverseRequests.js";

/**
 * What a host's MCP server sends the view that drives its project: the local
 * dispatch request minus its request id. `callerInfo` never crosses; the
 * confirm dialog stays provenance-free for a host's dispatch.
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

async function loadMcpServerService() {
  // Loaded on first use: most Shells are never asked, and the service is heavy.
  const { mcpServerService } = await import("../../services/McpServerService.js");
  return mcpServerService;
}

async function dispatchAction(webContentsId: number, payload: unknown): Promise<unknown> {
  const parsed = McpDispatchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError({ code: "VALIDATION", message: "Malformed MCP dispatch from the host" });
  }
  const request = parsed.data;
  const service = await loadMcpServerService();
  const envelope = await service.dispatchActionForHost(
    webContentsId,
    request.actionId,
    request.args,
    request.confirmed,
    request.context as ActionContext | undefined,
    request.sessionOrigin,
    {
      ...(request.offerSessionApproval ? { offerSessionApproval: true } : {}),
      ...(request.approvalOnly ? { approvalOnly: true } : {}),
    }
  );
  // Only what the host reads back: this machine's view identity stays here.
  return {
    result: envelope.result,
    ...(envelope.confirmationDecision !== undefined
      ? { confirmationDecision: envelope.confirmationDecision }
      : {}),
    ...(envelope.approvalScope !== undefined ? { approvalScope: envelope.approvalScope } : {}),
  };
}

/**
 * The reverse requests a host may send this Shell's views: MCP dispatch and
 * manifest reads for the view that drives a project, and notifications the
 * host decided to show. Returns a teardown.
 */
export function installViewReverseRequests(): () => void {
  const disposers = [
    registerReverseRequestMethod(MCP_DISPATCH_ACTION_METHOD, ({ webContentsId, payload }) =>
      dispatchAction(webContentsId, payload)
    ),
    registerReverseRequestMethod(MCP_GET_MANIFEST_METHOD, async ({ webContentsId }) =>
      (await loadMcpServerService()).requestManifestForHost(webContentsId)
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
