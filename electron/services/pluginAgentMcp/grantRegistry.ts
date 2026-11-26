import { createHash, randomBytes, randomUUID } from "node:crypto";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { createLogger } from "../../utils/logger.js";
import type { AgentMcpToolScope } from "./types.js";

const logger = createLogger("main:PluginAgentMcp");

interface PluginMcpGrantBase {
  /** Public correlation id. Safe to log and to hand the plugin. */
  readonly credentialId: string;
  readonly pluginInstanceId: string;
  /** The rosters this credential reaches, fixed when it is minted. */
  readonly scope: AgentMcpToolScope;
  /** The server key the plugin is named by in the project; a session reports it as its name. */
  readonly serverName: string;
  readonly projectId: string;
  readonly issuedAt: number;
}

/**
 * One credential for one plugin's MCP server, issued to one terminal launch in
 * one project. The bearer itself is never stored — only its digest — so nothing in
 * this registry can be replayed if it is ever logged or dumped.
 */
export interface PluginMcpLaunchGrant extends PluginMcpGrantBase {
  readonly bearerSha256: string;
  readonly terminalId: string;
  readonly launchAgentIdHint?: string;
  /**
   * Issued to the project's Daintree Assistant rather than to an agent the user
   * launched, so the Assistant's own answer is checked on every request too.
   */
  readonly consumer?: "assistant";
}

/**
 * One plugin's tools in one project for this machine's global Assistant
 * (#18254), held by its help session rather than a pane. It has no bearer:
 * nothing reaches it over the plugin route, only the in-process relay that
 * minted it, and it ends with that session.
 */
export interface PluginMcpGlobalAssistantGrant extends PluginMcpGrantBase {
  readonly consumer: "global-assistant";
  readonly helpSessionId: string;
}

export type PluginMcpGrant = PluginMcpLaunchGrant | PluginMcpGlobalAssistantGrant;

export function isPluginMcpLaunchGrant(grant: PluginMcpGrant): grant is PluginMcpLaunchGrant {
  return grant.consumer !== "global-assistant";
}

export interface IssuePluginMcpGrantParams {
  pluginInstanceId: string;
  scope: AgentMcpToolScope;
  serverName: string;
  projectId: string;
  terminalId: string;
  launchAgentIdHint?: string;
  consumer?: "assistant";
}

export interface IssueGlobalAssistantPluginMcpGrantParams {
  pluginInstanceId: string;
  scope: AgentMcpToolScope;
  serverName: string;
  projectId: string;
  helpSessionId: string;
}

export type PluginMcpGrantRevokeReason =
  | "terminal-exited"
  | "relaunched"
  | "plugin-unloaded"
  | "access-reduced"
  | "tools-regrouped"
  | "server-stopped"
  | "session-ended"
  | "rescoped";

/** What is remembered of a revoked grant: public identifiers and the reason, never the digest. */
export interface RevokedPluginMcpGrant {
  readonly credentialId: string;
  readonly pluginInstanceId: string;
  readonly terminalId: string;
  readonly reason: PluginMcpGrantRevokeReason;
  readonly revokedAt: number;
}

/**
 * Revocations remembered so a rejected bearer can be told apart from one that
 * was never issued. Enough for every terminal of a busy session to have been
 * relaunched a few times; older ones read as unknown.
 */
export const MAX_REMEMBERED_PLUGIN_MCP_REVOCATIONS = 256;

type RevokeListener = (
  grants: readonly PluginMcpGrant[],
  reason: PluginMcpGrantRevokeReason
) => void;

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function checkBinding(projectId: string, pluginInstanceId: string): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("plugin MCP grant: projectId must be a project workspace id");
  }
  // A project plugin's instance is bound to its own project's root; a grant
  // pairing it with another project would let that project reach its data.
  const boundProjectId = projectIdFromPluginInstanceKey(pluginInstanceId);
  if (boundProjectId !== null && boundProjectId !== projectId) {
    throw new Error("plugin MCP grant: project plugin instance belongs to a different project");
  }
}

function frozenScope(scope: AgentMcpToolScope): AgentMcpToolScope {
  const { databases, databaseWrites, pluginEndpointId, pluginGroups } = scope;
  if (!databases && !pluginEndpointId) {
    throw new Error("plugin MCP grant: the scope reaches no tools");
  }
  if (databaseWrites === true && !databases) {
    throw new Error("plugin MCP grant: database writes need the database tools");
  }
  if (pluginGroups !== undefined && (!pluginEndpointId || pluginGroups.length === 0)) {
    throw new Error(
      "plugin MCP grant: tool groups need the plugin's endpoint and at least one group"
    );
  }
  return Object.freeze({
    databases,
    ...(databaseWrites === true ? { databaseWrites } : {}),
    ...(pluginEndpointId ? { pluginEndpointId } : {}),
    ...(pluginGroups !== undefined
      ? {
          pluginGroups: Object.freeze(
            pluginGroups.map((group) => Object.freeze({ id: group.id, access: group.access }))
          ),
        }
      : {}),
  });
}

/**
 * Plugin endpoint credentials. Deliberately separate from every orchestration
 * bearer (api key, pane, help): a plugin grant authenticates the plugin route
 * only, and is never consulted by the orchestration auth gate.
 *
 * Grants live exactly as long as the terminal launch or global Assistant
 * session they were issued to, and never persist. Revocation deletes the grant first and then tells listeners,
 * so by the time the route closes sessions every new request already fails.
 */
export class PluginMcpGrantRegistry {
  private readonly byDigest = new Map<string, PluginMcpLaunchGrant>();
  private readonly byCredentialId = new Map<string, PluginMcpGrant>();
  /** Recent revocations by bearer digest, oldest first. Diagnostics only: never authenticates. */
  private readonly revokedByDigest = new Map<string, RevokedPluginMcpGrant>();
  private readonly listeners = new Set<RevokeListener>();
  /**
   * Grants whose plugin instance is mid-reload, by instance: the declared agent
   * surface of the generation they were issued against, and which credentials
   * the hold covers. A held grant still authenticates — its sessions stay open —
   * but reaches no plugin code until the next generation has been judged.
   */
  private readonly held = new Map<string, { surface: string; credentialIds: Set<string> }>();
  private readonly heldWaiters = new Set<() => void>();
  private readonly keptListeners = new Set<(grants: readonly PluginMcpGrant[]) => void>();

  /** Mint a grant. The returned token is the only copy of the bearer; hand it to the launch and drop it. */
  issue(
    params: IssuePluginMcpGrantParams,
    now: number = Date.now()
  ): {
    grant: PluginMcpLaunchGrant;
    token: string;
  } {
    checkBinding(params.projectId, params.pluginInstanceId);
    if (!params.terminalId) {
      throw new Error("plugin MCP grant: terminal id is required");
    }
    const scope = frozenScope(params.scope);
    const token = randomBytes(32).toString("base64url");
    const grant: PluginMcpLaunchGrant = Object.freeze({
      credentialId: randomUUID(),
      bearerSha256: digest(token),
      pluginInstanceId: params.pluginInstanceId,
      scope,
      serverName: params.serverName,
      projectId: params.projectId,
      terminalId: params.terminalId,
      ...(params.launchAgentIdHint !== undefined
        ? { launchAgentIdHint: params.launchAgentIdHint }
        : {}),
      ...(params.consumer !== undefined ? { consumer: params.consumer } : {}),
      issuedAt: now,
    });
    this.byDigest.set(grant.bearerSha256, grant);
    this.byCredentialId.set(grant.credentialId, grant);
    logger.info("Issued plugin MCP credential", {
      credentialId: grant.credentialId,
      pluginInstanceId: grant.pluginInstanceId,
      projectId: grant.projectId,
      terminalId: grant.terminalId,
      ...(grant.consumer !== undefined ? { consumer: grant.consumer } : {}),
    });
    return { grant, token };
  }

  /**
   * Mint a grant for this machine's global Assistant session in one project
   * (#18254). It authenticates nothing: the caller that minted it holds it by
   * credential id and checks {@link isLive} before each use.
   */
  issueForGlobalAssistant(
    params: IssueGlobalAssistantPluginMcpGrantParams,
    now: number = Date.now()
  ): PluginMcpGlobalAssistantGrant {
    checkBinding(params.projectId, params.pluginInstanceId);
    if (!params.helpSessionId) {
      throw new Error("plugin MCP grant: help session id is required");
    }
    const grant: PluginMcpGlobalAssistantGrant = Object.freeze({
      credentialId: randomUUID(),
      pluginInstanceId: params.pluginInstanceId,
      scope: frozenScope(params.scope),
      serverName: params.serverName,
      projectId: params.projectId,
      consumer: "global-assistant",
      helpSessionId: params.helpSessionId,
      issuedAt: now,
    });
    this.byCredentialId.set(grant.credentialId, grant);
    logger.info("Issued plugin MCP credential", {
      credentialId: grant.credentialId,
      pluginInstanceId: grant.pluginInstanceId,
      projectId: grant.projectId,
      consumer: grant.consumer,
    });
    return grant;
  }

  /** The live grant a bearer token names, or null. */
  authenticate(token: string): PluginMcpLaunchGrant | null {
    if (!token) return null;
    return this.byDigest.get(digest(token)) ?? null;
  }

  /**
   * Why a bearer that no longer authenticates stopped working, while its
   * revocation is still among the remembered ones. Null for a bearer that was
   * never issued, or was revoked too long ago to tell.
   */
  describeRevoked(token: string): RevokedPluginMcpGrant | null {
    if (!token) return null;
    return this.revokedByDigest.get(digest(token)) ?? null;
  }

  get(credentialId: string): PluginMcpGrant | null {
    return this.byCredentialId.get(credentialId) ?? null;
  }

  isLive(credentialId: string): boolean {
    return this.byCredentialId.has(credentialId);
  }

  listForTerminal(terminalId: string): PluginMcpLaunchGrant[] {
    return this.filter(
      (grant): grant is PluginMcpLaunchGrant =>
        isPluginMcpLaunchGrant(grant) && grant.terminalId === terminalId
    );
  }

  revokeTerminal(
    terminalId: string,
    reason: "terminal-exited" | "relaunched" = "terminal-exited"
  ): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) => isPluginMcpLaunchGrant(grant) && grant.terminalId === terminalId,
      reason
    );
  }

  /** Revoke one grant, as its holder replaces it. */
  revokeCredential(credentialId: string, reason: PluginMcpGrantRevokeReason): PluginMcpGrant[] {
    return this.revokeWhere((grant) => grant.credentialId === credentialId, reason);
  }

  /** Revoke what a global Assistant session held (#18254): it ended. */
  revokeHelpSession(helpSessionId: string): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) => grant.consumer === "global-assistant" && grant.helpSessionId === helpSessionId,
      "session-ended"
    );
  }

  /**
   * Suspend every grant for an instance that is about to reload, instead of
   * revoking it. The next generation inherits nothing on its own:
   * {@link releasePlugin} must judge it, and anything but the same declared
   * surface revokes. A second hold before the release keeps the first surface —
   * the credentials were issued against that one, not an intermediate.
   */
  holdPlugin(pluginInstanceId: string, surface: string): void {
    const credentialIds = new Set(
      this.filter((grant) => grant.pluginInstanceId === pluginInstanceId).map(
        (grant) => grant.credentialId
      )
    );
    const existing = this.held.get(pluginInstanceId);
    if (existing) {
      for (const id of credentialIds) existing.credentialIds.add(id);
      return;
    }
    if (credentialIds.size === 0) return;
    this.held.set(pluginInstanceId, { surface, credentialIds });
    logger.info("Holding plugin MCP credentials across a reload", {
      pluginInstanceId,
      credentialIds: [...credentialIds],
    });
  }

  /**
   * Settle a hold. `surface` is the reloaded generation's declared agent
   * surface, or null when no generation came back; the held grants survive only
   * when it matches the one they were issued against. Returns what was revoked.
   */
  releasePlugin(pluginInstanceId: string, surface: string | null): PluginMcpGrant[] {
    const hold = this.held.get(pluginInstanceId);
    if (!hold) return [];
    this.held.delete(pluginInstanceId);
    // Revoked before any waiter resumes, so a request parked on the hold wakes
    // to a dead credential rather than slipping through first.
    const kept = surface !== null && surface === hold.surface;
    const revoked = kept
      ? []
      : this.revokeWhere((grant) => hold.credentialIds.has(grant.credentialId), "plugin-unloaded");
    this.wakeHeldWaiters();
    if (kept) {
      const survivors = this.filter((grant) => hold.credentialIds.has(grant.credentialId));
      if (survivors.length > 0) {
        logger.info("Kept plugin MCP credentials across a reload", {
          pluginInstanceId,
          credentialIds: survivors.map((grant) => grant.credentialId),
        });
        for (const listener of this.keptListeners) {
          try {
            listener(survivors);
          } catch (err) {
            console.error("[PluginAgentMcp] kept listener threw:", err);
          }
        }
      }
    }
    return revoked;
  }

  /**
   * Resolves once `credentialId` is no longer held — kept or revoked — or after
   * `timeoutMs`, or when `signal` aborts, whichever is first. Re-check {@link isHeld} and
   * {@link isLive} afterwards; this only says the wait is over.
   */
  whenNotHeld(credentialId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.isHeld(credentialId) || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (!this.isHeld(credentialId)) done();
      };
      const done = (): void => {
        clearTimeout(timer);
        this.heldWaiters.delete(check);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.heldWaiters.add(check);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Settle every hold on an instance `matches` as "nothing came back", without
   * waiting for the reload that placed it. For teardown that cannot wait on a
   * reload stuck behind filesystem work: a close, or the service going away.
   */
  revokeHeld(matches: (pluginInstanceId: string) => boolean): PluginMcpGrant[] {
    const revoked: PluginMcpGrant[] = [];
    for (const pluginInstanceId of [...this.held.keys()]) {
      if (matches(pluginInstanceId)) revoked.push(...this.releasePlugin(pluginInstanceId, null));
    }
    return revoked;
  }

  /** Whether a live credential is suspended by a reload still in progress. */
  isHeld(credentialId: string): boolean {
    for (const hold of this.held.values()) {
      if (hold.credentialIds.has(credentialId)) return true;
    }
    return false;
  }

  revokePlugin(pluginInstanceId: string): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) => grant.pluginInstanceId === pluginInstanceId,
      "plugin-unloaded"
    );
  }

  /** Revoke every grant in a project that `isAllowed` no longer covers. */
  revokeDisabledInProject(
    projectId: string,
    isAllowed: (grant: PluginMcpGrant) => boolean
  ): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) => grant.projectId === projectId && !isAllowed(grant),
      "access-reduced"
    );
  }

  /** Revoke every grant for one plugin instance, in any project, that `isAllowed` no longer covers. */
  revokeDisallowedForPlugin(
    pluginInstanceId: string,
    isAllowed: (grant: PluginMcpGrant) => boolean
  ): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) => grant.pluginInstanceId === pluginInstanceId && !isAllowed(grant),
      "access-reduced"
    );
  }

  /**
   * Revoke every grant reaching an endpoint's tool groups, in any project: the
   * plugin moved a tool into or out of a group, so what the user allowed no
   * longer names the tools it did. Held grants go too — they were issued
   * against the old grouping.
   */
  revokeRegrouped(pluginInstanceId: string, endpointId: string): PluginMcpGrant[] {
    return this.revokeWhere(
      (grant) =>
        grant.pluginInstanceId === pluginInstanceId &&
        grant.scope.pluginEndpointId === endpointId &&
        grant.scope.pluginGroups !== undefined,
      "tools-regrouped"
    );
  }

  revokeAll(reason: PluginMcpGrantRevokeReason = "server-stopped"): PluginMcpGrant[] {
    return this.revokeWhere(() => true, reason);
  }

  /** Fires once per release that kept a reload's held grants, with the grants it kept. */
  onKept(listener: (grants: readonly PluginMcpGrant[]) => void): () => void {
    this.keptListeners.add(listener);
    return () => {
      this.keptListeners.delete(listener);
    };
  }

  /** Fires after grants are deleted, once per revocation batch, only when the batch is non-empty. */
  onRevoked(listener: RevokeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private rememberRevocation(
    grant: PluginMcpLaunchGrant,
    reason: PluginMcpGrantRevokeReason,
    revokedAt: number
  ): void {
    this.revokedByDigest.set(
      grant.bearerSha256,
      Object.freeze({
        credentialId: grant.credentialId,
        pluginInstanceId: grant.pluginInstanceId,
        terminalId: grant.terminalId,
        reason,
        revokedAt,
      })
    );
    for (const oldest of this.revokedByDigest.keys()) {
      if (this.revokedByDigest.size <= MAX_REMEMBERED_PLUGIN_MCP_REVOCATIONS) break;
      this.revokedByDigest.delete(oldest);
    }
  }

  private wakeHeldWaiters(): void {
    for (const check of [...this.heldWaiters]) check();
  }

  private filter<T extends PluginMcpGrant = PluginMcpGrant>(
    predicate: ((grant: PluginMcpGrant) => grant is T) | ((grant: PluginMcpGrant) => boolean)
  ): T[] {
    return [...this.byCredentialId.values()].filter(predicate) as T[];
  }

  private revokeWhere(
    predicate: (grant: PluginMcpGrant) => boolean,
    reason: PluginMcpGrantRevokeReason
  ): PluginMcpGrant[] {
    const revoked = this.filter(predicate);
    if (revoked.length === 0) return revoked;
    const revokedAt = Date.now();
    for (const grant of revoked) {
      if (isPluginMcpLaunchGrant(grant)) this.byDigest.delete(grant.bearerSha256);
      this.byCredentialId.delete(grant.credentialId);
      const hold = this.held.get(grant.pluginInstanceId);
      if (hold?.credentialIds.delete(grant.credentialId) && hold.credentialIds.size === 0) {
        this.held.delete(grant.pluginInstanceId);
      }
      // Only a bearer can come back to be told why it stopped working.
      if (isPluginMcpLaunchGrant(grant)) this.rememberRevocation(grant, reason, revokedAt);
    }
    const launches = revoked.filter(isPluginMcpLaunchGrant);
    logger.info("Revoked plugin MCP credentials", {
      reason,
      credentialIds: revoked.map((grant) => grant.credentialId),
      pluginInstanceIds: [...new Set(revoked.map((grant) => grant.pluginInstanceId))],
      terminalIds: [...new Set(launches.map((grant) => grant.terminalId))],
    });
    this.wakeHeldWaiters();
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
