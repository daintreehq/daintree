import type { MainProcessToastPayload } from "../../../shared/types/ipc/maps.js";
import type { HostDescriptor, HostId } from "../../../shared/types/remoteHosts.js";
import { LinkMethod, McpServerEnabledAnswerSchema } from "../host/linkMethods.js";
import type { LinkSession } from "../link/session.js";
import type { CloudHostStore } from "./CloudHostStore.js";

const CALL_TIMEOUT_MS = 30_000;

export interface CloudMcpServerOnConnectDeps {
  store: Pick<CloudHostStore, "bindingForHost" | "updateBinding">;
  hosts: { get(hostId: HostId): HostDescriptor | null };
  /** The host's open session, or null while it has none. */
  sessionFor(hostId: HostId): LinkSession | null;
  /** The host didn't say its server runs: the person who asked for it hears so. */
  unconfirmed(host: HostDescriptor, code: string | null): void;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/**
 * Said in the inbox, not as a toast: setup carried on, and the person may be
 * elsewhere by the time the host answers.
 */
export function mcpServerUnconfirmedToast(host: HostDescriptor): MainProcessToastPayload {
  return {
    type: "warning",
    priority: "low",
    title: "MCP server may be off",
    message: `${host.name} didn't confirm its MCP server is on, so your assistant may not be able to use it there. Check Settings → Integrations → MCP server on ${host.name}.`,
    replaceKey: `mcp-server-on-connect:${host.id}`,
  };
}

/**
 * Turns on a cloud machine's MCP server at its host's first connection, when
 * the person asked for that as they added the machine (#18187), so their
 * assistant can run tools there once setup finishes.
 *
 * The ask is taken off the binding before the call goes out: an answer lost
 * with its link is never asked again, so a server the host's owner turned off
 * meanwhile stays off. A Shell that quits between the two loses the ask, and
 * the host's Settings still turns the server on.
 */
export class CloudMcpServerOnConnect {
  private disposed = false;

  constructor(private readonly deps: CloudMcpServerOnConnectDeps) {}

  /** A link to a host came up: ask its host once, if its person asked for it. */
  sessionOpened(hostId: HostId, session: LinkSession): void {
    if (this.disposed) return;
    const binding = this.deps.store.bindingForHost(hostId);
    if (binding?.mcpServerOnConnect !== true) return;
    const host = this.deps.hosts.get(hostId);
    if (host?.connection.kind !== "cloud" || host.connection.bindingId !== binding.id) return;
    // A link already replaced leaves the ask to the one that replaced it.
    if (!session.isOpen || this.deps.sessionFor(hostId) !== session) return;
    try {
      this.deps.store.updateBinding(binding.id, ({ mcpServerOnConnect: _asked, ...rest }) => rest);
    } catch {
      // Not asked while the ask can't be taken off: the next link asks again.
      this.deps.unconfirmed(host, "WRITE_FAILED");
      return;
    }
    void this.enable(host, session);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async enable(host: HostDescriptor, session: LinkSession): Promise<void> {
    let running = false;
    let code: string | null = null;
    try {
      const answer = await session.call(LinkMethod.ENABLE_MCP_SERVER, null, {
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const parsed = McpServerEnabledAnswerSchema.safeParse(answer);
      running = parsed.success && parsed.data.running;
      if (!parsed.success) code = "VALIDATION";
    } catch (error) {
      code = errorCode(error);
    }
    if (!running && !this.disposed) this.deps.unconfirmed(host, code);
  }
}
