import {
  AGENT_MCP_CALL_TIMEOUT_MS,
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { PluginMcpSupervisor } from "../PluginMcpSupervisor.js";
import { agentMcpEndpointRegistry, type AgentMcpEndpointRegistry } from "./endpointRegistry.js";
import type {
  AgentMcpEndpointRegistration,
  AgentMcpServerSourceLookup,
  AgentMcpToolInvoker,
} from "./types.js";
import { validateAgentMcpTools } from "./validateTools.js";

type Supervisor = Pick<
  PluginMcpSupervisor,
  "start" | "getFullSchema" | "callTool" | "onDidInvalidateTools"
>;

export interface ContributedServerEndpointDeps {
  /** `PluginService.findAgentMcpServerSource`: the loaded instance's bridged endpoint, if any. */
  findSource: (pluginInstanceId: string) => AgentMcpServerSourceLookup | undefined;
  /** `PluginService.resolveSettingTemplate`, on the backend that holds the instance. */
  resolveSettings: (pluginInstanceId: string, settingId: string) => Promise<string>;
  supervisor: Supervisor;
  registry?: AgentMcpEndpointRegistry;
  /** First wait before restarting a server that failed; tests shorten it. */
  retryBaseMs?: number;
}

interface Bound {
  readonly serverKey: string;
  readonly registration: AgentMcpEndpointRegistration;
  readonly dispose: () => void;
  readonly boundAt: number;
}

/** First wait before starting a server that just failed; doubles per failure. */
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_MS = 30_000;
/** A server that stays up this long has recovered; an exit after it is not a crash loop. */
const STABLE_RUN_MS = 10_000;

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  const ellipsis = "…";
  const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > budget) break;
    out += char;
    bytes += size;
  }
  return out + ellipsis;
}

/**
 * Serves an `agentMcp` endpoint's tools from the plugin's own contributed MCP
 * server: the explicit adapter between `contributes.mcpServers`, where Daintree
 * is the client, and the agent route, where Daintree is the server.
 *
 * Nothing runs until an agent holding a grant for the endpoint lists or calls
 * a tool ({@link ensure}). Then the server is started by the supervisor on
 * this backend, with its settings resolved here, its schemas are read and
 * checked under the same rules as a `registerTools` roster, and only the tools
 * the manifest names are registered, under their agent-facing names. Any sign
 * the server's tools may have changed — an exit, a crash, a restart, a
 * `tools/list_changed` — drops the registration, so sessions are told their
 * list changed and the next demand starts over from a fresh read.
 */
export class ContributedServerEndpoints {
  private readonly registry: AgentMcpEndpointRegistry;
  private readonly retryBaseMs: number;
  private readonly bound = new Map<string, Bound>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** Per server, bumped on each invalidation, so a read that raced one never registers. */
  private readonly epochs = new Map<string, number>();
  /** Per server, recent failures to start or stay up, which space out the next start. */
  private readonly failures = new Map<string, { count: number; at: number }>();
  private offInvalidate: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: ContributedServerEndpointDeps) {
    this.registry = deps.registry ?? agentMcpEndpointRegistry;
    this.retryBaseMs = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  /**
   * Make sure the instance's bridged endpoint, if it has one, is registered.
   * Idempotent and shared between concurrent callers; rejects with why the
   * roster could not be served, leaving the endpoint unregistered.
   */
  ensure(pluginInstanceId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const lookup = this.deps.findSource(pluginInstanceId);
    if (!lookup) return Promise.resolve();
    const key = `${pluginInstanceId}\x00${lookup.endpointId}`;
    const current = this.bound.get(key);
    if (current && this.registry.get(pluginInstanceId, lookup.endpointId) === current.registration)
      return Promise.resolve();
    const existing = this.inflight.get(key);
    if (existing) return existing;
    // A server that fails to start, or crashes soon after, is not started
    // again on every request: each agent relists when told its tools changed.
    const serverKey = `${pluginInstanceId}\x00${lookup.contribution.id}`;
    const failure = this.failures.get(serverKey);
    if (failure) {
      const wait = failure.at + this.backoffMs(failure.count) - Date.now();
      if (wait > 0) {
        return Promise.reject(
          new Error(
            `MCP server "${lookup.contribution.id}" failed recently; it can start again in ${Math.ceil(wait / 1000)}s`
          )
        );
      }
    }
    const run = this.bind(pluginInstanceId, key, serverKey, lookup)
      .catch((err: unknown) => {
        this.recordFailure(serverKey);
        throw err;
      })
      .finally(() => {
        if (this.inflight.get(key) === run) this.inflight.delete(key);
      });
    this.inflight.set(key, run);
    return run;
  }

  private backoffMs(count: number): number {
    return Math.min(MAX_RETRY_MS, this.retryBaseMs * 2 ** Math.max(0, count - 1));
  }

  private recordFailure(serverKey: string): void {
    const count = (this.failures.get(serverKey)?.count ?? 0) + 1;
    this.failures.set(serverKey, { count, at: Date.now() });
  }

  private async bind(
    pluginInstanceId: string,
    key: string,
    serverKey: string,
    lookup: AgentMcpServerSourceLookup
  ): Promise<void> {
    this.listen();
    const { contribution, source } = lookup;
    const serverId = contribution.id;
    const epoch = this.epochs.get(serverKey) ?? 0;
    await this.deps.supervisor.start({
      pluginId: pluginInstanceId,
      pluginDir: lookup.pluginDir,
      contributions: [{ ...contribution }],
      resolveSettings: (settingId) => this.deps.resolveSettings(pluginInstanceId, settingId),
    });

    const roster: Record<string, Record<string, unknown>> = {};
    for (const tool of source.tools) {
      const found = await this.deps.supervisor.getFullSchema(
        pluginInstanceId,
        serverId,
        tool.serverTool
      );
      if (!found.found) {
        throw new Error(
          `MCP server "${serverId}" lists no tool "${tool.serverTool}" for agent tool "${tool.name}"`
        );
      }
      const upstream = found.tool.description?.trim();
      roster[tool.name] = {
        description:
          tool.description ??
          truncateUtf8(
            upstream ? upstream : `${tool.serverTool} from ${contribution.name}`,
            AGENT_MCP_MAX_DESCRIPTION_BYTES
          ),
        inputSchema: found.tool.inputSchema,
        ...(tool.group !== undefined ? { group: tool.group } : {}),
      };
    }
    let tools: AgentMcpEndpointRegistration["tools"];
    try {
      tools = validateAgentMcpTools(roster, {
        declaredQueryNames: new Set(lookup.declaredQueryNames),
        groups: lookup.groups,
        hostDispatched: true,
      });
    } catch (err) {
      throw new Error(
        `MCP server "${serverId}" cannot serve agentMcp endpoint "${lookup.endpointId}": ${formatErrorMessage(err, "invalid tool roster")}`,
        { cause: err }
      );
    }

    // The server's tools changed under the read, the instance went away, or
    // this adapter was disposed: what was read may not be what is now served.
    if (this.disposed) throw new Error("Contributed server endpoints were disposed");
    if ((this.epochs.get(serverKey) ?? 0) !== epoch) {
      throw new Error(`MCP server "${serverId}" changed while its tools were being read`);
    }
    if (this.deps.findSource(pluginInstanceId)?.contribution !== contribution) {
      throw new Error(`Plugin "${pluginInstanceId}" is no longer loaded`);
    }

    const serverTools = new Map(source.tools.map((tool) => [tool.name, tool.serverTool]));
    const invoke: AgentMcpToolInvoker = (toolName, args, _caller, signal) => {
      const serverTool = serverTools.get(toolName);
      if (serverTool === undefined) {
        return Promise.reject(
          new Error(`Endpoint "${lookup.endpointId}" has no tool "${toolName}"`)
        );
      }
      return this.deps.supervisor.callTool({
        pluginId: pluginInstanceId,
        serverId,
        tool: serverTool,
        args,
        signal,
        timeoutMs: AGENT_MCP_CALL_TIMEOUT_MS,
      });
    };
    const registration: AgentMcpEndpointRegistration = {
      pluginInstanceId,
      endpointId: lookup.endpointId,
      tools,
      invoke,
      resultFormat: "mcp",
    };
    const dispose = this.registry.register(registration);
    this.bound.set(key, { serverKey, registration, dispose, boundAt: Date.now() });
  }

  private listen(): void {
    if (this.offInvalidate) return;
    this.offInvalidate = this.deps.supervisor.onDidInvalidateTools((pluginId, serverId, reason) => {
      const serverKey = `${pluginId}\x00${serverId}`;
      this.epochs.set(serverKey, (this.epochs.get(serverKey) ?? 0) + 1);
      for (const [key, entry] of this.bound) {
        if (entry.serverKey !== serverKey) continue;
        this.bound.delete(key);
        entry.dispose();
        if (reason !== "exited") continue;
        if (Date.now() - entry.boundAt < STABLE_RUN_MS) this.recordFailure(serverKey);
        else this.failures.delete(serverKey);
      }
    });
  }

  /** Drop every registration and stop listening. Servers stay with their supervisor. */
  dispose(): void {
    this.disposed = true;
    this.offInvalidate?.();
    this.offInvalidate = null;
    for (const entry of this.bound.values()) entry.dispose();
    this.bound.clear();
    this.inflight.clear();
    this.epochs.clear();
    this.failures.clear();
  }
}
