// Session provisioning + per-agent env construction for help-session
// launches, split out of HelpSessionController.ts (#11009). These are pure
// functions with no controller state — moved verbatim, no behavior change.

import { logError } from "@/utils/logger";
import { extractHelpSessionErrorCode } from "@/utils/clientHelpSessionError";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionContext } from "@shared/types/actions";
import type { HelpProjectRef, LaunchErrorKind } from "./HelpSessionController";
import { DEFAULT_ASSISTANT_SLOT } from "@shared/config/assistantSlots";

export interface HelpSessionRef {
  sessionId: string;
  sessionPath: string;
  token: string;
  mcpUrl: string | null;
  windowId: number;
}

/**
 * Per-agent env injection for help-session launches. Today this is a
 * placeholder shape — no agent currently requires renderer-side env beyond
 * the universal `DAINTREE_MCP_TOKEN` / `DAINTREE_WINDOW_ID` set in
 * `buildHelpEnv`. The hook stays so future per-agent env additions have a
 * single place to land.
 */
function agentSpawnEnv(_agentId: string, _sessionPath: string): Record<string, string> {
  return {};
}

export type ProvisionFailureCode =
  | "MCP_NOT_READY"
  | "MCP_SERVER_NOT_STARTED"
  | "MCP_PROBE_FAILED"
  | "USER_CONTENT_SYNC_FAILED"
  | "UNKNOWN";

export type ProvisionOutcome =
  | { ok: true; session: HelpSessionRef }
  | { ok: false; code: ProvisionFailureCode; message: string };

export async function provisionHelpSession(
  project: HelpProjectRef,
  agentId: string,
  context?: ActionContext,
  /**
   * The assistant lane to provision into (#12108). Main displaces only the
   * prior session in this lane, so naming it is what lets sibling sessions
   * survive a launch.
   */
  slot: number = DEFAULT_ASSISTANT_SLOT
): Promise<ProvisionOutcome> {
  try {
    const result = await window.electron.help.provisionSession({
      projectId: project.id,
      projectPath: project.path,
      agentId,
      slot,
      ...(context && { context }),
    });
    if (!result) {
      return {
        ok: false,
        code: "UNKNOWN",
        message: "Couldn't provision help session.",
      };
    }
    return { ok: true, session: result };
  } catch (err) {
    logError("Failed to provision help session", err);
    // Decode BEFORE formatting: the contextBridge strips the custom `code`
    // property, so it rides an encoded message prefix the decoder strips.
    const code = extractHelpSessionErrorCode(err);
    const message = formatErrorMessage(err, "Couldn't provision help session");
    if (
      code === "MCP_SERVER_NOT_STARTED" ||
      code === "MCP_PROBE_FAILED" ||
      code === "MCP_NOT_READY" ||
      code === "USER_CONTENT_SYNC_FAILED"
    ) {
      return { ok: false, code, message };
    }
    return { ok: false, code: "UNKNOWN", message };
  }
}

export function provisionFailureKind(code: ProvisionFailureCode): LaunchErrorKind {
  switch (code) {
    case "MCP_SERVER_NOT_STARTED":
      return "mcp-server-not-started";
    // Legacy `MCP_NOT_READY` errors fall through to the probe-failed shape —
    // the "server responded badly" copy is the closer fit.
    case "MCP_PROBE_FAILED":
    case "MCP_NOT_READY":
      return "mcp-probe-failed";
    case "USER_CONTENT_SYNC_FAILED":
      return "skills-sync-failed";
    default:
      return "spawn-failed";
  }
}

export function buildHelpEnv(
  session: HelpSessionRef | null,
  projectId: string | null,
  agentId: string
): Record<string, string> | undefined {
  if (!session) return undefined;
  const env: Record<string, string> = {
    DAINTREE_MCP_TOKEN: session.token,
    DAINTREE_WINDOW_ID: String(session.windowId),
    ...agentSpawnEnv(agentId, session.sessionPath),
  };
  if (session.mcpUrl) env.DAINTREE_MCP_URL = session.mcpUrl;
  if (projectId) env.DAINTREE_PROJECT_ID = projectId;
  return env;
}

export function revokeHelpSession(sessionId: string | null): void {
  if (!sessionId) return;
  window.electron.help.revokeSession(sessionId).catch((err) => {
    logError("Failed to revoke help session", err);
  });
}

export function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return undefined;
    out[k] = v;
  }
  return out;
}
