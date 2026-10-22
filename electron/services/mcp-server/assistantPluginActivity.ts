import { CHANNELS } from "../../ipc/channels.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import {
  computeMcpAuditSeverity,
  type McpToolCallSettledPayload,
  type McpToolCallStartedPayload,
} from "../../../shared/types/ipc/mcpServer.js";
import type { PluginMcpGrant } from "../pluginAgentMcp/grantRegistry.js";
import type { PluginToolCallOutcome } from "../pluginAgentMcp/pluginSessionServer.js";
import { classifyMcpDispatchResult, type AuditOutcome, type AuditService } from "./auditLog.js";

/** The Daintree Assistant lane a terminal serves, as its activity strip is reached. */
export interface AssistantPluginLane {
  /** The public help-session id the lane's panel filters pushes by. */
  helpSessionId: string;
  /** The view holding the lane's panel; one that is gone just receives nothing. */
  webContentsId: number;
  tier: HelpAssistantTier;
}

export interface AssistantPluginActivityDeps {
  /** The lane a terminal currently serves, or null when it serves none. */
  resolveLane: (terminalId: string) => AssistantPluginLane | null;
  getCurrentTurnId: (helpSessionId: string) => string | null;
  appendAuditRecord: AuditService["appendRecord"];
  send: (webContentsId: number, channel: string, buildPayload: () => unknown) => void;
  now?: () => number;
}

/**
 * Report a tool call made through an Assistant's plugin grant the way calls to
 * Daintree's own server are reported: the live started and settled pushes the
 * lane's activity strip shows, and an audit record its recent calls read back.
 * Names the call `<server key>.<tool>`, the server key being the one the agent
 * was handed, so it reads as the plugin's and never as one of Daintree's
 * actions.
 *
 * What a plugin's tools take and return is the user's own data, so neither
 * reaches the strip or the log: the summary lists argument names only.
 *
 * Returns undefined, observing nothing, for any grant but an Assistant's, or
 * when its terminal no longer serves a lane.
 */
export function observeAssistantPluginToolCall(
  deps: AssistantPluginActivityDeps,
  grant: PluginMcpGrant,
  toolName: string,
  argNames: readonly string[]
): ((outcome: PluginToolCallOutcome) => void) | undefined {
  if (grant.consumer !== "assistant") return undefined;
  const lane = deps.resolveLane(grant.terminalId);
  if (lane === null) return undefined;

  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Read once, so the started push, the settled push and the record agree on
  // the turn even when it ends mid-call.
  const turnId = deps.getCurrentTurnId(lane.helpSessionId);
  const toolId = `${grant.serverName}.${toolName}`;
  const argsSummary = argNames.join(", ");

  deps.send(lane.webContentsId, CHANNELS.MCP_TOOL_CALL_STARTED, (): McpToolCallStartedPayload => ({
    sessionId: lane.helpSessionId,
    toolId,
    argsSummary,
    startedAt,
    danger: false,
    ...(turnId !== null ? { turnId } : {}),
  }));

  let settled = false;
  return (outcome) => {
    if (settled) return;
    settled = true;
    const durationMs = Math.max(0, now() - startedAt);
    const auditOutcome: AuditOutcome = {
      kind: "result",
      value:
        outcome === "ok"
          ? { ok: true, result: null }
          : {
              ok: false,
              error: { code: "EXECUTION_ERROR", message: "The plugin tool returned an error." },
            },
    };
    const { result, errorCode } = classifyMcpDispatchResult(auditOutcome);
    // The lane's panel may have moved to another view while the call ran.
    const current = deps.resolveLane(grant.terminalId);
    const target = current?.helpSessionId === lane.helpSessionId ? current : lane;
    deps.send(
      target.webContentsId,
      CHANNELS.MCP_TOOL_CALL_SETTLED,
      (): McpToolCallSettledPayload => ({
        sessionId: lane.helpSessionId,
        toolId,
        durationMs: Math.round(durationMs),
        result,
        ...(errorCode !== undefined ? { errorCode } : {}),
        severity: computeMcpAuditSeverity(result, errorCode),
        ...(turnId !== null ? { turnId } : {}),
      })
    );
    deps.appendAuditRecord({
      toolId,
      // The grant's public correlation id stands in for a transport session.
      sessionId: grant.credentialId,
      tier: lane.tier,
      args: undefined,
      durationMs,
      startedAt,
      outcome: auditOutcome,
      argsSummary,
      helpSessionId: lane.helpSessionId,
      rendererOwnedOrigin: true,
      ...(turnId !== null ? { turnId } : {}),
    });
  };
}
