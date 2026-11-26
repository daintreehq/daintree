import { McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PluginMcpGlobalAssistantCaller } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { agentMcpEndpointRegistry, type AgentMcpEndpointRegistry } from "./endpointRegistry.js";
import {
  pluginMcpGrantRegistry,
  type PluginMcpGlobalAssistantGrant,
  type PluginMcpGrantRegistry,
} from "./grantRegistry.js";
import type * as PluginServiceModule from "../PluginService.js";
import { listDeclaredAgentMcpPlugins } from "./declaredEndpoints.js";
import {
  resolveLaunchPluginsReport,
  type LaunchPlugin,
  type LaunchPluginsReport,
} from "./launchPlugins.js";
import {
  createPluginToolSession,
  TOOL_GROUP_META_KEY,
  type PluginToolSession,
} from "./pluginSessionServer.js";
import { assistantAgentMcpScopeFor } from "./projectEnablement.js";
import type { AgentMcpToolScope, DeclaredAgentMcpPlugin } from "./types.js";

/**
 * Structured `plugin.tools` replies are kept to this, inside the 50 KiB a
 * `host.call` answer carries whole (`MCP_RESPONSE_TEXT_MAX_BYTES`) with room
 * for its envelope, so a long roster pages rather than being cut. One row of
 * the largest legal tool still fits on a page of its own.
 */
export const DEFAULT_PLUGIN_TOOLS_PAGE_BYTES = 32 * 1024;

/** How much of why a plugin's tools couldn't be listed is passed on. */
const MAX_UNAVAILABLE_REASON_CHARS = 300;

export interface GlobalAssistantPluginToolsDeps {
  /** The project's folder on this machine; null when it has no such project. */
  projectRoot(projectId: string): Promise<string | null>;
  /** The plugins the project's Assistant answer hands over there, with their scopes. */
  resolvePlugins(projectId: string, projectRoot: string): Promise<LaunchPluginsReport>;
  /** The plugin's declaration as loaded right now; null once it no longer serves the project. */
  declaredPlugin(projectId: string, pluginInstanceId: string): DeclaredAgentMcpPlugin | null;
  activatePlugin(pluginInstanceId: string): Promise<void>;
  /** Whether a help session is still this machine's running, coordinating global Assistant. */
  isSessionLive(helpSessionId: string): boolean;
  /**
   * Why a call that may change the project can't run there now, or null when
   * it can. Read in the same turn as the tool's dispatch.
   */
  refuseWrite?(projectId: string): string | null;
  grants?: PluginMcpGrantRegistry;
  endpointRegistry?: AgentMcpEndpointRegistry;
  callTimeoutMs?: number;
  maxResultBytes?: number;
  pageBytes?: number;
}

interface HeldTools {
  readonly grant: PluginMcpGlobalAssistantGrant;
  readonly tools: PluginToolSession;
  /** Aborts every list and call made under the grant once it is revoked. */
  readonly lifetime: AbortController;
}

/** A row of `plugin.tools`: what the plugin's own MCP server would list, and whose it is. */
export interface GlobalAssistantPluginToolRow {
  pluginInstanceId: string;
  plugin: string;
  name: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  annotations?: Tool["annotations"];
  group?: { id: string; access: string };
}

const SESSION_ENDED = "This assistant session has ended. Nothing was run.";

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function answer(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameScope(a: AgentMcpToolScope, b: AgentMcpToolScope): boolean {
  const groups = (scope: AgentMcpToolScope) =>
    scope.pluginGroups === undefined
      ? null
      : scope.pluginGroups
          .map((group) => `${group.id}\u0000${group.access}`)
          .sort()
          .join("\u0001");
  return (
    a.databases === b.databases &&
    (a.databaseWrites === true) === (b.databaseWrites === true) &&
    a.pluginEndpointId === b.pluginEndpointId &&
    groups(a) === groups(b)
  );
}

function keyOf(helpSessionId: string, projectId: string, pluginInstanceId: string): string {
  return `${helpSessionId}\u0000${projectId}\u0000${pluginInstanceId}`;
}

function rowOf(launch: LaunchPlugin, tool: Tool): GlobalAssistantPluginToolRow {
  const group = (tool._meta as Record<string, unknown> | undefined)?.[TOOL_GROUP_META_KEY];
  return {
    pluginInstanceId: launch.plugin.pluginInstanceId,
    plugin: launch.plugin.pluginDisplayName.trim() || launch.plugin.pluginManifestId,
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(isPlainObject(group) && typeof group.id === "string" && typeof group.access === "string"
      ? { group: { id: group.id, access: group.access } }
      : {}),
  };
}

/**
 * The plugin agent tools a project's Assistant is allowed, reached by this
 * machine's global Assistant through `host.call` with no launch in that
 * project (#18254). Each (session, project, plugin) holds one grant from the
 * registry, so unloading the plugin, a reload that changes it, the person
 * narrowing the Assistant's answer, and the session ending all revoke it as
 * they would a pane's. The answer is read again at every list and call, and
 * once more just before the plugin's code runs.
 */
export class GlobalAssistantPluginTools {
  private readonly grants: PluginMcpGrantRegistry;
  private readonly endpoints: AgentMcpEndpointRegistry;
  private readonly held = new Map<string, HeldTools>();
  private readonly offRevoked: () => void;
  private disposed = false;

  constructor(private readonly deps: GlobalAssistantPluginToolsDeps) {
    this.grants = deps.grants ?? pluginMcpGrantRegistry;
    this.endpoints = deps.endpointRegistry ?? agentMcpEndpointRegistry;
    // The grant goes first, so whatever was running under it stops with it.
    this.offRevoked = this.grants.onRevoked((revoked) => {
      for (const grant of revoked) {
        if (grant.consumer !== "global-assistant") continue;
        const key = keyOf(grant.helpSessionId, grant.projectId, grant.pluginInstanceId);
        const entry = this.held.get(key);
        if (entry?.grant.credentialId !== grant.credentialId) continue;
        this.held.delete(key);
        entry.lifetime.abort();
      }
    });
  }

  /** `plugin.tools`: every tool the project's plugins offer its Assistant, a page at a time. */
  async list(
    helpSessionId: string,
    projectId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CallToolResult> {
    const extra = Object.keys(args).filter((key) => key !== "pluginInstanceId" && key !== "cursor");
    if (extra.length > 0) return failure(`plugin.tools takes no ${extra.join(", ")}.`);
    if (args.pluginInstanceId !== undefined && typeof args.pluginInstanceId !== "string") {
      return failure("pluginInstanceId should be a string.");
    }
    const offset = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return failure("cursor should be the nextCursor of an earlier plugin.tools answer.");
    }
    const resolved = await this.resolve(helpSessionId, projectId);
    if (typeof resolved === "string") return failure(resolved);
    // Before any grant is minted or plugin started for a call already gone.
    if (signal.aborted) return failure("The call was cancelled.");
    const only = args.pluginInstanceId;
    const launches = resolved.plugins.filter(
      (launch) => only === undefined || launch.plugin.pluginInstanceId === only
    );
    const listed = await Promise.all(
      launches.map(async (launch) => {
        const held = this.heldFor(helpSessionId, projectId, launch);
        if (typeof held === "string") return { launch, error: held };
        try {
          return { launch, held, tools: await held.tools.listTools(signal) };
        } catch (err) {
          return { launch, error: formatErrorMessage(err, "Its tools couldn't be listed.") };
        }
      })
    );
    if (signal.aborted) return failure("The call was cancelled.");
    if (this.disposed || !this.deps.isSessionLive(helpSessionId)) return failure(SESSION_ENDED);
    // A plugin whose tools were taken away while another was still listing
    // leaves no row behind.
    const rows = listed.flatMap(({ launch, held, tools }) =>
      held !== undefined && this.isServable(held.grant)
        ? (tools ?? []).map((tool) => rowOf(launch, tool))
        : []
    );
    const unavailable = listed.flatMap(({ launch, error }) =>
      error === undefined
        ? []
        : [
            {
              pluginInstanceId: launch.plugin.pluginInstanceId,
              reason:
                error.length > MAX_UNAVAILABLE_REASON_CHARS
                  ? `${error.slice(0, MAX_UNAVAILABLE_REASON_CHARS)}…`
                  : error,
            },
          ]
    );
    const off = resolved.declared
      .filter(
        ({ plugin, scope }) =>
          scope === null && (only === undefined || plugin.pluginInstanceId === only)
      )
      .map(({ plugin }) => ({
        pluginInstanceId: plugin.pluginInstanceId,
        plugin: plugin.pluginDisplayName.trim() || plugin.pluginManifestId,
      }));
    const budget = this.deps.pageBytes ?? DEFAULT_PLUGIN_TOOLS_PAGE_BYTES;
    const page: GlobalAssistantPluginToolRow[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ unavailable, off }), "utf8") + 128;
    let next = offset;
    while (next < rows.length) {
      const size = Buffer.byteLength(JSON.stringify(rows[next]), "utf8") + 1;
      // A page always carries at least one row, so a huge schema can't stall it.
      if (page.length > 0 && bytes + size > budget) break;
      page.push(rows[next]);
      bytes += size;
      next += 1;
    }
    return answer({
      tools: page,
      nextCursor: next < rows.length ? String(next) : null,
      unavailable,
      off,
      stillLoading: resolved.pending,
    });
  }

  /** `plugin.callTool`: one of those tools, by the plugin and name a `plugin.tools` row gave. */
  async call(
    helpSessionId: string,
    projectId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CallToolResult> {
    const extra = Object.keys(args).filter(
      (key) => key !== "pluginInstanceId" && key !== "tool" && key !== "arguments"
    );
    if (extra.length > 0) return failure(`plugin.callTool takes no ${extra.join(", ")}.`);
    const { pluginInstanceId, tool } = args;
    if (typeof pluginInstanceId !== "string" || pluginInstanceId === "") {
      return failure("pluginInstanceId should be the pluginInstanceId of a plugin.tools row.");
    }
    if (typeof tool !== "string" || tool === "") {
      return failure("tool should be the name of a plugin.tools row.");
    }
    const toolArgs = args.arguments ?? {};
    if (!isPlainObject(toolArgs)) return failure("arguments should be an object.");
    const resolved = await this.resolve(helpSessionId, projectId);
    if (typeof resolved === "string") return failure(resolved);
    const launch = resolved.plugins.find(
      (candidate) => candidate.plugin.pluginInstanceId === pluginInstanceId
    );
    if (launch === undefined) {
      const declared = resolved.declared.find(
        (entry) => entry.plugin.pluginInstanceId === pluginInstanceId
      );
      // No plugin on for the Assistant here means this one isn't either.
      if (declared?.scope === null || resolved.noAccess === true) {
        return failure(
          "That plugin's agent tools aren't on for the Assistant in this project. Nothing was run. The person can turn them on in the project's settings."
        );
      }
      if (resolved.pending) {
        return failure("This project's plugins are still loading. Nothing was run. Retry shortly.");
      }
      return failure(
        "No plugin with that pluginInstanceId offers tools in this project. Nothing was run. List them with plugin.tools."
      );
    }
    if (signal.aborted) return failure("The call was cancelled. Nothing was run.");
    const held = this.heldFor(helpSessionId, projectId, launch);
    if (typeof held === "string") return failure(held);
    try {
      return await held.tools.callTool(tool, toolArgs, signal);
    } catch (err) {
      // An unknown tool, or one this grant doesn't reach: the same answer the
      // plugin's own server gives, as a tool error the caller can read.
      return failure(err instanceof McpError ? err.message : formatErrorMessage(err, "Failed."));
    }
  }

  /** The session ended: whatever it held in any project goes now. */
  endSession(helpSessionId: string): void {
    this.grants.revokeHelpSession(helpSessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.offRevoked();
    const sessions = new Set([...this.held.values()].map(({ grant }) => grant.helpSessionId));
    for (const entry of this.held.values()) entry.lifetime.abort();
    this.held.clear();
    for (const helpSessionId of sessions) this.grants.revokeHelpSession(helpSessionId);
  }

  private async resolve(
    helpSessionId: string,
    projectId: string
  ): Promise<LaunchPluginsReport | string> {
    if (this.disposed || !this.deps.isSessionLive(helpSessionId)) return SESSION_ENDED;
    if (!isProjectWorkspaceId(projectId)) return "That isn't one of this machine's projects.";
    const root = await this.deps.projectRoot(projectId);
    if (root === null) return "That isn't one of this machine's projects.";
    return this.deps.resolvePlugins(projectId, root);
  }

  /**
   * The grant this session holds for the plugin at the scope the answer gives
   * it now, read in this turn from the plugin as loaded rather than from what
   * the call resolved earlier, so a call that resolved before a settings change
   * never replaces a fresher grant with a stale one. Minted on first use and
   * replaced when the scope changed. Refused once the session has ended:
   * checked in the same turn as the mint, so a session that ended while this
   * call resolved plugins never gets one.
   */
  private heldFor(
    helpSessionId: string,
    projectId: string,
    launch: LaunchPlugin
  ): HeldTools | string {
    if (this.disposed || !this.deps.isSessionLive(helpSessionId)) return SESSION_ENDED;
    const pluginInstanceId = launch.plugin.pluginInstanceId;
    const scope = this.currentScope(projectId, pluginInstanceId);
    if (scope === null) {
      return "That plugin's agent tools changed while the call started. Nothing was run. List them again with plugin.tools.";
    }
    const key = keyOf(helpSessionId, projectId, pluginInstanceId);
    const existing = this.held.get(key);
    if (
      existing !== undefined &&
      this.grants.isLive(existing.grant.credentialId) &&
      sameScope(existing.grant.scope, scope)
    ) {
      return existing;
    }
    if (existing !== undefined) {
      this.held.delete(key);
      existing.lifetime.abort();
      this.grants.revokeCredential(existing.grant.credentialId, "rescoped");
    }
    const grant = this.grants.issueForGlobalAssistant({
      pluginInstanceId,
      scope,
      serverName: launch.serverKey,
      projectId,
      helpSessionId,
    });
    const caller: PluginMcpGlobalAssistantCaller = Object.freeze({
      credentialId: grant.credentialId,
      projectId,
      consumer: "global-assistant" as const,
    });
    const lifetime = new AbortController();
    const tools = createPluginToolSession({
      pluginInstanceId,
      scope: grant.scope,
      caller,
      sessionSignal: lifetime.signal,
      isCallerServable: () => this.isServable(grant),
      // A host-owned read can't change the project; anything else may, and
      // runs only while no other machine drives it, judged as it dispatches.
      refuseDispatch: (tool) =>
        tool.readOnly === true ? null : (this.deps.refuseWrite?.(projectId) ?? null),
      activatePlugin: this.deps.activatePlugin,
      endpointRegistry: this.endpoints,
      ...(this.deps.callTimeoutMs !== undefined ? { callTimeoutMs: this.deps.callTimeoutMs } : {}),
      ...(this.deps.maxResultBytes !== undefined
        ? { maxResultBytes: this.deps.maxResultBytes }
        : {}),
    });
    const entry: HeldTools = { grant, tools, lifetime };
    this.held.set(key, entry);
    return entry;
  }

  /**
   * Read again right before any plugin code runs: a reload or a settings
   * change between the call's start and its dispatch must not reach code the
   * answer no longer allows, even where no revocation has fired yet.
   */
  private isServable(grant: PluginMcpGlobalAssistantGrant): boolean {
    if (this.disposed) return false;
    if (!this.grants.isLive(grant.credentialId) || this.grants.isHeld(grant.credentialId)) {
      return false;
    }
    if (!this.deps.isSessionLive(grant.helpSessionId)) return false;
    const scope = this.currentScope(grant.projectId, grant.pluginInstanceId);
    return scope !== null && sameScope(scope, grant.scope);
  }

  private currentScope(projectId: string, pluginInstanceId: string): AgentMcpToolScope | null {
    const declared = this.deps.declaredPlugin(projectId, pluginInstanceId);
    return declared === null ? null : assistantAgentMcpScopeFor(projectId, declared);
  }
}

type PluginServiceSingleton = typeof PluginServiceModule.pluginService;

/**
 * The adapter as main runs it. PluginService is loaded only once a project's
 * Assistant answer turns out to allow some plugin, as for a launch, so a
 * global Assistant listing a project with none costs nothing.
 */
export function createGlobalAssistantPluginTools(
  deps: Pick<
    GlobalAssistantPluginToolsDeps,
    "activatePlugin" | "isSessionLive" | "refuseWrite" | "pageBytes"
  >
): GlobalAssistantPluginTools {
  let loaded: PluginServiceSingleton | null = null;
  const loadPluginService = async (): Promise<PluginServiceSingleton> => {
    loaded ??= (await import("../PluginService.js")).pluginService;
    return loaded;
  };
  return new GlobalAssistantPluginTools({
    ...deps,
    projectRoot: async (projectId) => {
      const { projectStore } = await import("../ProjectStore.js");
      return projectStore.getProjectById(projectId)?.path ?? null;
    },
    resolvePlugins: (projectId, projectRoot) =>
      resolveLaunchPluginsReport(projectId, projectRoot, "assistant", loadPluginService),
    declaredPlugin: (projectId, pluginInstanceId) => {
      const service = loaded;
      if (service === null) return null;
      return (
        listDeclaredAgentMcpPlugins(service.listPlugins(), projectId, (id) =>
          service.hasPlugin(id)
        ).find((plugin) => plugin.pluginInstanceId === pluginInstanceId) ?? null
      );
    },
  });
}
