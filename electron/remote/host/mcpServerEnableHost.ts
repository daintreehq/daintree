import { createLogger } from "../../utils/logger.js";
import type { LinkSession } from "../link/session.js";
import { EmptyPayloadSchema, LinkMethod, type McpServerEnabledAnswer } from "./linkMethods.js";

export interface McpServerEnableHostServer {
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

const logger = createLogger("main:mcpServerEnableHost");

async function enableMcpServer(): Promise<McpServerEnabledAnswer> {
  const { mcpServerService } = await import("../../services/McpServerService.js");
  try {
    await mcpServerService.setEnabled(true);
  } catch (error) {
    // Why it didn't start stays here: the Shell is told only that it doesn't run.
    logger.warn("Couldn't start the MCP server a Shell turned on", { error });
  }
  // Enabled is saved before the start: a start that couldn't bind still leaves it on for the next.
  return { running: mcpServerService.isRunning };
}

/**
 * Host mode: turn this machine's MCP server on when an attached Shell asks,
 * which it does once, for a cloud machine whose person asked for it when
 * adding it (#18187). A window on this host can already do the same through
 * `mcp-server:set-enabled`; this asks for no view, carries no key, and never
 * turns the server off.
 */
export function installMcpServerEnableHost(
  server: McpServerEnableHostServer,
  enable: () => Promise<McpServerEnabledAnswer> = enableMcpServer
): () => void {
  return server.onSession(({ session }) => {
    const off = session.registerCallHandler(LinkMethod.ENABLE_MCP_SERVER, EmptyPayloadSchema, () =>
      enable()
    );
    session.onClose(off);
  });
}
