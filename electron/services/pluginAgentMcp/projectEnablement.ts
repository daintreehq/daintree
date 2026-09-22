import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { pluginMcpGrantRegistry } from "./grantRegistry.js";

/**
 * Which plugin MCP endpoints the user has turned on for which project. Keyed
 * `projectId → pluginInstanceId → endpointId → { decidedAt }`; presence means on.
 *
 * Keyed by plugin INSTANCE, not manifest id: a project plugin may share its
 * manifest id with an installed one, and consent given to one must never reach
 * the other. This store is machine-local, so the project id embedded in a
 * project plugin's instance key is stable for as long as the answer matters.
 *
 * Exposing a plugin's tools to a project's agents is its own decision, separate
 * from installing or trusting the plugin, so enabling a plugin never exposes
 * anything by itself. Kept in the user's store rather than the repository for
 * the same reason as `projectPluginVisibility`: a repository that could switch
 * this on would be deciding for everyone who clones it, agents included.
 *
 * No in-memory copy, matching `projectSurfaceChoices.ts` — reads happen once
 * per terminal launch and per agent request, writes on a click.
 */
const STORE_KEY = "projectAgentMcpEnablement";

export interface AgentMcpEnablementRecord {
  decidedAt: number;
}

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
}

/** Own-property read, so an id like `__proto__` can never resolve through the prototype. */
function own(dict: Dict | null, key: string): unknown {
  return dict !== null && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/** A copy with a null prototype, so assigning any id — `__proto__` included — makes an own key. */
function copy(dict: Dict | null): Dict {
  return Object.assign(Object.create(null) as Dict, dict ?? {});
}

function isRecord(value: unknown): value is AgentMcpEnablementRecord {
  const dict = asDict(value);
  return dict !== null && typeof own(dict, "decidedAt") === "number";
}

function readAll(): Dict {
  return asDict(store.get(STORE_KEY) as unknown) ?? {};
}

/** True only for an explicit, well-formed "on" record. The file is user-editable. */
export function isAgentMcpEndpointEnabled(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean {
  const project = asDict(own(readAll(), projectId));
  const plugin = asDict(own(project, pluginInstanceId));
  return isRecord(own(plugin, endpointId));
}

/** Every enabled `[pluginInstanceId, endpointId]` pair for a project. */
export function listEnabledAgentMcpEndpoints(
  projectId: string
): Array<{ pluginInstanceId: string; endpointId: string }> {
  const project = asDict(own(readAll(), projectId));
  if (!project) return [];
  const enabled: Array<{ pluginInstanceId: string; endpointId: string }> = [];
  for (const [pluginInstanceId, rawPlugin] of Object.entries(project)) {
    const plugin = asDict(rawPlugin);
    if (!plugin) continue;
    for (const [endpointId, rawRecord] of Object.entries(plugin)) {
      if (isRecord(rawRecord)) enabled.push({ pluginInstanceId, endpointId });
    }
  }
  return enabled;
}

/**
 * Turn an endpoint on or off for a project. Turning it off revokes every live
 * credential for it in that project immediately; running agents lose the tools
 * on their next request. Turning it on reaches terminals launched afterwards.
 */
export function setAgentMcpEndpointEnabled(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string,
  enabled: boolean,
  now: number = Date.now()
): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("agent MCP: projectId must be a project workspace id");
  }
  if (!pluginInstanceId || !endpointId) {
    throw new Error("agent MCP: plugin and endpoint ids are required");
  }

  // A read failure propagates: this rewrites the whole key, so writing from a
  // map we could not read would drop every other project's answers.
  const all = copy(readAll());
  const project = copy(asDict(own(all, projectId)));
  const plugin = copy(asDict(own(project, pluginInstanceId)));
  if (enabled) {
    plugin[endpointId] = { decidedAt: now } satisfies AgentMcpEnablementRecord;
  } else {
    delete plugin[endpointId];
  }
  if (Object.keys(plugin).length === 0) delete project[pluginInstanceId];
  else project[pluginInstanceId] = plugin;
  if (Object.keys(project).length === 0) delete all[projectId];
  else all[projectId] = project;
  // Whole-key rewrite: electron-store dot-notation would nest on the dots in a
  // plugin id.
  store.set(STORE_KEY, all);

  if (!enabled) {
    pluginMcpGrantRegistry.revokeEndpoint(projectId, pluginInstanceId, endpointId);
  }
}
