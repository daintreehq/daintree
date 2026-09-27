import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { pluginMcpGrantRegistry } from "./grantRegistry.js";
import {
  hasProjectMcpDefaults,
  isProjectDefaultEndpoint,
  refreshProjectMcpDefaults,
} from "./projectDefaults.js";

/**
 * Which plugin MCP endpoints the user has turned on or off for which project.
 * Keyed `projectId → pluginInstanceId → endpointId → { decidedAt, enabled? }`;
 * a record without `enabled` (the original shape) means on.
 *
 * Keyed by plugin INSTANCE, not manifest id: a project plugin may share its
 * manifest id with an installed one, and consent given to one must never reach
 * the other. This store is machine-local, so the project id embedded in a
 * project plugin's instance key is stable for as long as the answer matters.
 *
 * Exposing a plugin's tools to a project's agents is its own decision, separate
 * from installing or trusting the plugin, so enabling a plugin never exposes
 * anything by itself. The one thing a repository may decide is a default for
 * its OWN plugins, in `.daintree/mcp.json` (`projectDefaults.ts`): those run
 * only once the user trusts the project's plugins, and an installed plugin is
 * never reachable that way. An answer recorded here beats that default in both
 * directions, which is why turning an endpoint off is stored rather than erased.
 *
 * No in-memory copy, matching `projectSurfaceChoices.ts` — reads happen once
 * per terminal launch and per agent request, writes on a click.
 */
const STORE_KEY = "projectAgentMcpEnablement";

export interface AgentMcpEnablementRecord {
  decidedAt: number;
  /** Absent in records written before a repository could set a default; means on. */
  enabled?: boolean;
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
  if (dict === null || typeof own(dict, "decidedAt") !== "number") return false;
  const enabled = own(dict, "enabled");
  return enabled === undefined || typeof enabled === "boolean";
}

function isOnRecord(value: unknown): boolean {
  return isRecord(value) && value.enabled !== false;
}

function readAll(): Dict {
  return asDict(store.get(STORE_KEY) as unknown) ?? {};
}

/**
 * The user's own answer for an endpoint, or null when they never gave one.
 * Only a well-formed record counts: the file is user-editable.
 */
function userAnswer(projectId: string, pluginInstanceId: string, endpointId: string) {
  const project = asDict(own(readAll(), projectId));
  const plugin = asDict(own(project, pluginInstanceId));
  const record = own(plugin, endpointId);
  return isRecord(record) ? record.enabled !== false : null;
}

/**
 * Whether agents in this project may reach the endpoint: the user's answer when
 * they gave one, otherwise the project's own default. Synchronous, because the
 * plugin route asks on every request; the default is whatever
 * `refreshProjectMcpDefaults` last read, which every launch refreshes.
 */
export function isAgentMcpEndpointEnabled(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean {
  return (
    userAnswer(projectId, pluginInstanceId, endpointId) ??
    isProjectDefaultEndpoint(projectId, pluginInstanceId, endpointId)
  );
}

/** Whether the user answered for this endpoint at all, as opposed to it following the project default. */
export function hasUserAgentMcpAnswer(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean {
  return userAnswer(projectId, pluginInstanceId, endpointId) !== null;
}

/**
 * Whether anything could be on for this project — a user's "on" or a project
 * default — so a launch in a project with neither never loads PluginService.
 */
export function hasAnyAgentMcpEnablement(projectId: string): boolean {
  return listEnabledAgentMcpEndpoints(projectId).length > 0 || hasProjectMcpDefaults(projectId);
}

/**
 * Re-read the project's `.daintree/mcp.json` and revoke every live grant it no
 * longer allows: an endpoint dropped from the file stops working for agents
 * already running, as switching it off in Settings does, rather than staying
 * live until they exit (and coming back if the file is restored).
 */
export async function refreshProjectAgentMcpDefaults(
  projectId: string,
  projectRoot: string | null | undefined
): Promise<void> {
  await refreshProjectMcpDefaults(projectId, projectRoot);
  pluginMcpGrantRegistry.revokeDisabledInProject(projectId, (grant) =>
    isAgentMcpEndpointEnabled(projectId, grant.pluginInstanceId, grant.endpointId)
  );
}

/** Every `[pluginInstanceId, endpointId]` pair the user turned on for a project. */
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
      if (isOnRecord(rawRecord)) enabled.push({ pluginInstanceId, endpointId });
    }
  }
  return enabled;
}

/**
 * Record the user's answer for an endpoint in a project. Turning it off revokes
 * every live credential for it in that project immediately; running agents lose
 * the tools on their next request. Turning it on reaches terminals launched
 * afterwards. Either answer outranks the project's `.daintree/mcp.json` default.
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
  plugin[endpointId] = enabled
    ? ({ decidedAt: now } satisfies AgentMcpEnablementRecord)
    : ({ decidedAt: now, enabled: false } satisfies AgentMcpEnablementRecord);
  project[pluginInstanceId] = plugin;
  all[projectId] = project;
  // Whole-key rewrite: electron-store dot-notation would nest on the dots in a
  // plugin id.
  store.set(STORE_KEY, all);

  if (!enabled) {
    pluginMcpGrantRegistry.revokeEndpoint(projectId, pluginInstanceId, endpointId);
  }
}
