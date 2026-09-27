import type { PluginMcpCaller } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  resolvePluginDatabaseLocation,
  type PluginDatabaseDeclaration,
} from "../plugin/pluginDatabase.js";
import { runDatabaseToolInProcess } from "./databaseQueryProcess.js";
import {
  DATABASE_QUERY_TOOL,
  DATABASE_SCHEMA_TOOL,
  DATABASE_TOOL_DESCRIPTORS,
  type DatabaseQueryParams,
  type DatabaseTarget,
  type DatabaseToolRequest,
} from "./databaseTools.js";
import { agentMcpEndpointRegistry, type AgentMcpEndpointRegistry } from "./endpointRegistry.js";
import {
  DATABASE_ENDPOINT_ID,
  type AgentMcpRegisteredTool,
  type AgentMcpToolInvoker,
} from "./types.js";
import { compileAgentMcpTool } from "./validateTools.js";

let compiledTools: readonly AgentMcpRegisteredTool[] | null = null;
function databaseTools(): readonly AgentMcpRegisteredTool[] {
  compiledTools ??= Object.freeze(DATABASE_TOOL_DESCRIPTORS.map(compileAgentMcpTool));
  return compiledTools;
}

export interface PluginDatabaseEndpointOptions {
  pluginInstanceId: string;
  manifestId: string;
  declarations: readonly (PluginDatabaseDeclaration & { description?: string })[];
  /** The project a project plugin is bound to; null for an installed plugin. */
  boundProjectId: string | null;
  boundProjectRoot: string | null;
  dataDir: string;
  /**
   * The root of the caller's project, for an installed plugin's `project`
   * database: such a plugin has no project of its own, but the agent's grant
   * names exactly one.
   */
  resolveProjectRoot: (projectId: string) => string | null;
  /** False once this plugin instance has unloaded or been replaced. */
  isCurrent: () => boolean;
  run?: (request: DatabaseToolRequest, signal: AbortSignal) => Promise<unknown>;
  registry?: AgentMcpEndpointRegistry;
}

function codedError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Serve a plugin's declared databases to agents on {@link DATABASE_ENDPOINT_ID}.
 * The host owns this roster, not the plugin: it is bound at load, before and
 * independent of activation, so neither listing nor calling it runs plugin
 * code, and an idle worker being disposed leaves it in place. Returns the
 * disposer; unloading the plugin also drops it through the registry.
 */
export function registerPluginDatabaseEndpoint(options: PluginDatabaseEndpointOptions): () => void {
  const {
    pluginInstanceId,
    manifestId,
    declarations,
    boundProjectId,
    boundProjectRoot,
    dataDir,
    resolveProjectRoot,
    isCurrent,
    run = runDatabaseToolInProcess,
    registry = agentMcpEndpointRegistry,
  } = options;

  const projectRootFor = (caller: PluginMcpCaller): string | null => {
    if (boundProjectId !== null) {
      // Grants are per project already; this keeps a project plugin's files
      // out of reach of any other project even if one were minted wrongly.
      if (caller.projectId !== boundProjectId) {
        throw codedError("PROJECT_MISMATCH", "this plugin belongs to a different project");
      }
      return boundProjectRoot;
    }
    return resolveProjectRoot(caller.projectId);
  };

  const target = async (
    declaration: PluginDatabaseEndpointOptions["declarations"][number],
    projectRoot: string | null
  ): Promise<DatabaseTarget> => {
    const base = {
      id: declaration.id,
      location: declaration.location,
      ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    };
    try {
      const resolved = await resolvePluginDatabaseLocation({
        declaration,
        manifestId,
        projectRoot,
        dataDir,
        existingOnly: true,
      });
      return { ...base, resolved, problem: null };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        ...base,
        resolved: null,
        problem: {
          code: typeof code === "string" ? code : "DB_UNAVAILABLE",
          message: formatErrorMessage(error, "database unavailable"),
        },
      };
    }
  };

  const declared = (databaseId: unknown) => {
    const declaration = declarations.find((d) => d.id === databaseId);
    if (!declaration) {
      throw codedError(
        "DB_NOT_DECLARED",
        `this plugin declares no database "${String(databaseId)}"; call ${DATABASE_SCHEMA_TOOL} to list them`
      );
    }
    return declaration;
  };

  const invoke: AgentMcpToolInvoker = async (toolName, args, caller, signal) => {
    if (!isCurrent()) throw new Error(`Plugin "${pluginInstanceId}" is not loaded`);
    const projectRoot = projectRootFor(caller);
    let request: DatabaseToolRequest;
    if (toolName === DATABASE_SCHEMA_TOOL) {
      const selected = args.databaseId === undefined ? declarations : [declared(args.databaseId)];
      const targets = await Promise.all(selected.map((d) => target(d, projectRoot)));
      request = { tool: DATABASE_SCHEMA_TOOL, targets };
    } else if (toolName === DATABASE_QUERY_TOOL) {
      const resolved = await target(declared(args.databaseId), projectRoot);
      // Nothing to open, so no process to start.
      if (!resolved.resolved) {
        const problem = resolved.problem ?? { code: "DB_UNAVAILABLE", message: "unavailable" };
        throw codedError(problem.code, problem.message.replace(/^[A-Z_]+: /, ""));
      }
      request = {
        tool: DATABASE_QUERY_TOOL,
        target: resolved,
        sql: args.sql as string,
        ...(args.params !== undefined ? { params: args.params as DatabaseQueryParams } : {}),
        ...(args.rowLimit !== undefined ? { rowLimit: args.rowLimit as number } : {}),
      };
    } else {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    // Resolution awaited the filesystem; the plugin may have gone meanwhile.
    if (!isCurrent()) throw new Error(`Plugin "${pluginInstanceId}" is not loaded`);
    return run(request, signal);
  };

  return registry.register({
    pluginInstanceId,
    endpointId: DATABASE_ENDPOINT_ID,
    tools: databaseTools(),
    invoke,
  });
}
