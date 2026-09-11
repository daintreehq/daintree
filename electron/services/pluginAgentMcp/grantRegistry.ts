import { createHash, randomBytes, randomUUID } from "node:crypto";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";

/**
 * One credential for one plugin endpoint, issued to one terminal launch in one
 * project. The bearer itself is never stored — only its digest — so nothing in
 * this registry can be replayed if it is ever logged or dumped.
 */
export interface PluginMcpGrant {
  /** Public correlation id. Safe to log and to hand the plugin. */
  readonly credentialId: string;
  readonly bearerSha256: string;
  readonly pluginInstanceId: string;
  readonly endpointId: string;
  readonly projectId: string;
  readonly terminalId: string;
  readonly launchAgentIdHint?: string;
  readonly issuedAt: number;
}

export interface IssuePluginMcpGrantParams {
  pluginInstanceId: string;
  endpointId: string;
  projectId: string;
  terminalId: string;
  launchAgentIdHint?: string;
}

export type PluginMcpGrantRevokeReason =
  "terminal-exited" | "plugin-unloaded" | "endpoint-disabled" | "server-stopped";

type RevokeListener = (
  grants: readonly PluginMcpGrant[],
  reason: PluginMcpGrantRevokeReason
) => void;

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Plugin endpoint credentials. Deliberately separate from every orchestration
 * bearer (api key, pane, help): a plugin grant authenticates the plugin route
 * only, and is never consulted by the orchestration auth gate.
 *
 * Grants live exactly as long as the terminal launch they were issued to, and
 * never persist. Revocation deletes the grant first and then tells listeners,
 * so by the time the route closes sessions every new request already fails.
 */
export class PluginMcpGrantRegistry {
  private readonly byDigest = new Map<string, PluginMcpGrant>();
  private readonly byCredentialId = new Map<string, PluginMcpGrant>();
  private readonly listeners = new Set<RevokeListener>();

  /** Mint a grant. The returned token is the only copy of the bearer; hand it to the launch and drop it. */
  issue(
    params: IssuePluginMcpGrantParams,
    now: number = Date.now()
  ): {
    grant: PluginMcpGrant;
    token: string;
  } {
    if (!isProjectWorkspaceId(params.projectId)) {
      throw new Error("plugin MCP grant: projectId must be a project workspace id");
    }
    // A project plugin's instance is bound to its own project's root; a grant
    // pairing it with another project would let that project reach its data.
    const boundProjectId = projectIdFromPluginInstanceKey(params.pluginInstanceId);
    if (boundProjectId !== null && boundProjectId !== params.projectId) {
      throw new Error("plugin MCP grant: project plugin instance belongs to a different project");
    }
    if (!params.endpointId || !params.terminalId) {
      throw new Error("plugin MCP grant: endpoint and terminal ids are required");
    }
    const token = randomBytes(32).toString("base64url");
    const grant: PluginMcpGrant = Object.freeze({
      credentialId: randomUUID(),
      bearerSha256: digest(token),
      pluginInstanceId: params.pluginInstanceId,
      endpointId: params.endpointId,
      projectId: params.projectId,
      terminalId: params.terminalId,
      ...(params.launchAgentIdHint !== undefined
        ? { launchAgentIdHint: params.launchAgentIdHint }
        : {}),
      issuedAt: now,
    });
    this.byDigest.set(grant.bearerSha256, grant);
    this.byCredentialId.set(grant.credentialId, grant);
    return { grant, token };
  }

  /** The live grant a bearer token names, or null. */
  authenticate(token: string): PluginMcpGrant | null {
    if (!token) return null;
    return this.byDigest.get(digest(token)) ?? null;
  }

  get(credentialId: string): PluginMcpGrant | null {
    return this.byCredentialId.get(credentialId) ?? null;
  }

  isLive(credentialId: string): boolean {
    return this.byCredentialId.has(credentialId);
  }

  listForTerminal(terminalId: string): PluginMcpGrant[] {
    return this.filter((grant) => grant.terminalId === terminalId);
  }

  revokeTerminal(terminalId: string): PluginMcpGrant[] {
    return this.revokeWhere((grant) => grant.terminalId === terminalId, "terminal-exited");
  }

  revokePlugin(pluginInstanceId: string): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) => grant.pluginInstanceId === pluginInstanceId,
      "plugin-unloaded"
    );
  }

  /** Revoke every grant for one endpoint of one plugin instance in one project. */
  revokeEndpoint(
    projectId: string,
    pluginInstanceId: string,
    endpointId: string
  ): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) =>
        grant.projectId === projectId &&
        grant.pluginInstanceId === pluginInstanceId &&
        grant.endpointId === endpointId,
      "endpoint-disabled"
    );
  }

  revokeAll(reason: PluginMcpGrantRevokeReason = "server-stopped"): PluginMcpGrant[] {
    return this.revokeWhere(() => true, reason);
  }

  /** Fires after grants are deleted, once per revocation batch, only when the batch is non-empty. */
  onRevoked(listener: RevokeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private filter(predicate: (grant: PluginMcpGrant) => boolean): PluginMcpGrant[] {
    return [...this.byCredentialId.values()].filter(predicate);
  }

  private revokeWhere(
    predicate: (grant: PluginMcpGrant) => boolean,
    reason: PluginMcpGrantRevokeReason
  ): PluginMcpGrant[] {
    const revoked = this.filter(predicate);
    if (revoked.length === 0) return revoked;
    for (const grant of revoked) {
      this.byDigest.delete(grant.bearerSha256);
      this.byCredentialId.delete(grant.credentialId);
    }
    for (const listener of this.listeners) {
      try {
        listener(revoked, reason);
      } catch (err) {
        console.error("[PluginAgentMcp] revoke listener threw:", err);
      }
    }
    return revoked;
  }
}

export const pluginMcpGrantRegistry = new PluginMcpGrantRegistry();
