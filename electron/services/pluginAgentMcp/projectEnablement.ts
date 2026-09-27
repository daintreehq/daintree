import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";
import {
  AGENT_MCP_ACCESS_LEVELS,
  type AgentMcpAccess,
} from "../../../shared/types/ipc/pluginAgentMcp.js";
import { pluginMcpGrantRegistry, type PluginMcpGrant } from "./grantRegistry.js";
import {
  accessAllowsEndpoint,
  hasProjectMcpDefaults,
  isProjectDefaultEndpoint,
  refreshProjectMcpDefaults,
} from "./projectDefaults.js";
import {
  DATABASE_ENDPOINT_ID,
  type AgentMcpToolScope,
  type DeclaredAgentMcpPlugin,
} from "./types.js";

/**
 * How much of each plugin's agent tools the user lets agents use: off, the
 * host's read-only database tools, or those and the plugin's own tools. Three
 * places can answer, and the first that does wins:
 *
 * 1. The user's answer for the project (`projectAgentMcpAccess`,
 *    `projectId → pluginInstanceId → { decidedAt, access }`). `access: null`
 *    is a deliberate "follow the default", which also retires answer 2.
 * 2. An answer given before access levels existed, one endpoint at a time
 *    (`projectAgentMcpEnablement`, `projectId → pluginInstanceId → endpointId →
 *    { decidedAt, enabled? }`; no `enabled` means on). Read as it always was, so
 *    nothing a user already chose changes until they choose again.
 * 3. For an installed plugin, the user's answer for every project
 *    (`pluginAgentMcpAccess`, `pluginInstanceId → { decidedAt, access }`). For a
 *    project plugin, the repository's `.daintree/mcp.json` (`projectDefaults.ts`)
 *    — a repository never reaches an installed plugin, which would let any clone
 *    read the user's own plugin data through their agents.
 *
 * Keyed by plugin INSTANCE, not manifest id: a project plugin may share its
 * manifest id with an installed one, and consent given to one must never reach
 * the other. This store is machine-local, so the project id embedded in a
 * project plugin's instance key is stable for as long as the answer matters.
 *
 * Exposing a plugin's tools to agents is its own decision, separate from
 * installing or trusting the plugin, so enabling a plugin never exposes anything
 * by itself.
 *
 * No in-memory copy, matching `projectSurfaceChoices.ts` — reads happen once per
 * terminal launch and per agent request, writes on a click.
 */
const LEGACY_STORE_KEY = "projectAgentMcpEnablement";
const PROJECT_STORE_KEY = "projectAgentMcpAccess";
const ALL_PROJECTS_STORE_KEY = "pluginAgentMcpAccess";

export interface AgentMcpAccessRecord {
  decidedAt: number;
  /** Null (project answers only) means "follow the default for every project". */
  access: AgentMcpAccess | null;
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

function read(key: string): Dict {
  return asDict(store.get(key) as unknown) ?? {};
}

function isAccess(value: unknown): value is AgentMcpAccess {
  return (AGENT_MCP_ACCESS_LEVELS as readonly unknown[]).includes(value);
}

/** Only a well-formed record counts: the file is user-editable. */
function accessRecord(value: unknown): AgentMcpAccessRecord | null {
  const dict = asDict(value);
  if (dict === null || typeof own(dict, "decidedAt") !== "number") return null;
  const access = own(dict, "access");
  if (access !== null && !isAccess(access)) return null;
  return { decidedAt: dict.decidedAt as number, access };
}

function isLegacyRecord(value: unknown): boolean {
  const dict = asDict(value);
  if (dict === null || typeof own(dict, "decidedAt") !== "number") return false;
  const enabled = own(dict, "enabled");
  return enabled === undefined || typeof enabled === "boolean";
}

function isLegacyOn(value: unknown): boolean {
  return isLegacyRecord(value) && asDict(value)!.enabled !== false;
}

/** The user's answer for the project: a level, null for "follow the default", undefined for none. */
export function projectAgentMcpAccessAnswer(
  projectId: string,
  pluginInstanceId: string
): AgentMcpAccess | null | undefined {
  const record = accessRecord(
    own(asDict(own(read(PROJECT_STORE_KEY), projectId)), pluginInstanceId)
  );
  return record === null ? undefined : record.access;
}

/** The user's answer for every project, for an installed plugin; null when there is none. */
export function allProjectsAgentMcpAccess(pluginInstanceId: string): AgentMcpAccess | null {
  if (projectIdFromPluginInstanceKey(pluginInstanceId) !== null) return null;
  return accessRecord(own(read(ALL_PROJECTS_STORE_KEY), pluginInstanceId))?.access ?? null;
}

function legacyAnswers(projectId: string, pluginInstanceId: string): Dict | null {
  return asDict(own(asDict(own(read(LEGACY_STORE_KEY), projectId)), pluginInstanceId));
}

function legacyAnswer(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean | null {
  const record = own(legacyAnswers(projectId, pluginInstanceId), endpointId);
  return isLegacyRecord(record) ? isLegacyOn(record) : null;
}

/** Whether a pre-access-level answer for the plugin still governs it in this project. */
export function hasLegacyAgentMcpAnswer(projectId: string, pluginInstanceId: string): boolean {
  if (projectAgentMcpAccessAnswer(projectId, pluginInstanceId) !== undefined) return false;
  const answers = legacyAnswers(projectId, pluginInstanceId);
  return answers !== null && Object.values(answers).some(isLegacyRecord);
}

/** Endpoint ids a pre-access-level answer names for the plugin, for a plugin that is gone. */
export function listLegacyAgentMcpEndpointIds(
  projectId: string,
  pluginInstanceId: string
): string[] {
  const answers = legacyAnswers(projectId, pluginInstanceId);
  return Object.entries(answers ?? {})
    .filter(([, record]) => isLegacyRecord(record))
    .map(([endpointId]) => endpointId);
}

/** What a roster gets with no answer for the project: the all-projects answer, or the repository's. */
export function isAgentMcpEndpointEnabledByDefault(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean {
  if (projectIdFromPluginInstanceKey(pluginInstanceId) !== null) {
    return isProjectDefaultEndpoint(projectId, pluginInstanceId, endpointId);
  }
  const access = allProjectsAgentMcpAccess(pluginInstanceId);
  return access !== null && accessAllowsEndpoint(access, endpointId);
}

/**
 * Whether agents in this project may reach one of a plugin's rosters —
 * `@databases` or the plugin's own endpoint id. Synchronous, because the plugin
 * route asks on every request; the repository default is whatever
 * `refreshProjectMcpDefaults` last read, which every launch refreshes.
 */
export function isAgentMcpEndpointEnabled(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean {
  const answer = projectAgentMcpAccessAnswer(projectId, pluginInstanceId);
  if (answer !== undefined && answer !== null) return accessAllowsEndpoint(answer, endpointId);
  if (answer === undefined) {
    const legacy = legacyAnswer(projectId, pluginInstanceId, endpointId);
    if (legacy !== null) return legacy;
  }
  return isAgentMcpEndpointEnabledByDefault(projectId, pluginInstanceId, endpointId);
}

/** The rosters a new grant for this plugin may reach in the project, or null for none. */
export function agentMcpScopeFor(
  projectId: string,
  plugin: DeclaredAgentMcpPlugin
): AgentMcpToolScope | null {
  const id = plugin.pluginInstanceId;
  const databases =
    plugin.hasDatabases && isAgentMcpEndpointEnabled(projectId, id, DATABASE_ENDPOINT_ID);
  const pluginEndpointId =
    plugin.pluginEndpoint && isAgentMcpEndpointEnabled(projectId, id, plugin.pluginEndpoint.id)
      ? plugin.pluginEndpoint.id
      : undefined;
  if (!databases && pluginEndpointId === undefined) return null;
  return { databases, ...(pluginEndpointId !== undefined ? { pluginEndpointId } : {}) };
}

/** Whether the project's current access still covers everything in a scope. */
export function isAgentMcpScopeAllowed(
  projectId: string,
  pluginInstanceId: string,
  scope: AgentMcpToolScope
): boolean {
  return (
    (!scope.databases ||
      isAgentMcpEndpointEnabled(projectId, pluginInstanceId, DATABASE_ENDPOINT_ID)) &&
    (scope.pluginEndpointId === undefined ||
      isAgentMcpEndpointEnabled(projectId, pluginInstanceId, scope.pluginEndpointId))
  );
}

export function isPluginMcpGrantAllowed(grant: PluginMcpGrant): boolean {
  return isAgentMcpScopeAllowed(grant.projectId, grant.pluginInstanceId, grant.scope);
}

/**
 * Every plugin instance with an answer on record that lets this project's
 * agents reach something, whether or not that plugin is running now — so
 * settings can keep an answer for a plugin that went away visible and
 * revocable.
 */
export function listAgentMcpAccessInstances(projectId: string): string[] {
  const ids = new Set<string>();
  const project = asDict(own(read(PROJECT_STORE_KEY), projectId));
  for (const [id, raw] of Object.entries(project ?? {})) {
    const access = accessRecord(raw)?.access;
    if (access !== undefined && access !== null && access !== "off") ids.add(id);
  }
  const legacy = asDict(own(read(LEGACY_STORE_KEY), projectId));
  for (const [id, raw] of Object.entries(legacy ?? {})) {
    if (projectAgentMcpAccessAnswer(projectId, id) !== undefined) continue;
    if (Object.values(asDict(raw) ?? {}).some(isLegacyOn)) ids.add(id);
  }
  for (const [id, raw] of Object.entries(read(ALL_PROJECTS_STORE_KEY))) {
    if (projectIdFromPluginInstanceKey(id) !== null) continue;
    const access = accessRecord(raw)?.access;
    if (access !== undefined && access !== null && access !== "off") ids.add(id);
  }
  return [...ids];
}

/**
 * Whether anything could be on for this project — an answer or a repository
 * default — so a launch in a project with neither never loads PluginService.
 */
export function hasAnyAgentMcpEnablement(projectId: string): boolean {
  return listAgentMcpAccessInstances(projectId).length > 0 || hasProjectMcpDefaults(projectId);
}

/**
 * Re-read the project's `.daintree/mcp.json` and revoke every live grant it no
 * longer allows: a plugin dropped from the file stops working for agents
 * already running, as switching it off in Settings does, rather than staying
 * live until they exit (and coming back if the file is restored).
 */
export async function refreshProjectAgentMcpDefaults(
  projectId: string,
  projectRoot: string | null | undefined
): Promise<void> {
  await refreshProjectMcpDefaults(projectId, projectRoot);
  pluginMcpGrantRegistry.revokeDisabledInProject(projectId, isPluginMcpGrantAllowed);
}

/**
 * Record the user's answer for a plugin in a project; null follows the default
 * again. Anything it takes away is revoked at once for that project's agents,
 * which lose the plugin's server on their next request; anything it adds
 * reaches terminals launched afterwards.
 */
export function setProjectAgentMcpAccess(
  projectId: string,
  pluginInstanceId: string,
  access: AgentMcpAccess | null,
  now: number = Date.now()
): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("agent MCP: projectId must be a project workspace id");
  }
  if (!pluginInstanceId) throw new Error("agent MCP: plugin id is required");

  // A read failure propagates: this rewrites the whole key, so writing from a
  // map we could not read would drop every other project's answers.
  const all = copy(read(PROJECT_STORE_KEY));
  const project = copy(asDict(own(all, projectId)));
  project[pluginInstanceId] = { decidedAt: now, access } satisfies AgentMcpAccessRecord;
  all[projectId] = project;
  // Whole-key rewrite: electron-store dot-notation would nest on the dots in a
  // plugin id.
  store.set(PROJECT_STORE_KEY, all);

  pluginMcpGrantRegistry.revokeDisabledInProject(
    projectId,
    (grant) => grant.pluginInstanceId !== pluginInstanceId || isPluginMcpGrantAllowed(grant)
  );
}

/**
 * Record the user's answer for an installed plugin in every project without an
 * answer of its own; null removes it. Revokes, in every project, whatever that
 * takes away.
 */
export function setAllProjectsAgentMcpAccess(
  pluginInstanceId: string,
  access: AgentMcpAccess | null,
  now: number = Date.now()
): void {
  if (!pluginInstanceId) throw new Error("agent MCP: plugin id is required");
  if (projectIdFromPluginInstanceKey(pluginInstanceId) !== null) {
    throw new Error("agent MCP: only an installed plugin has an answer for every project");
  }
  const all = copy(read(ALL_PROJECTS_STORE_KEY));
  if (access === null) delete all[pluginInstanceId];
  else all[pluginInstanceId] = { decidedAt: now, access } satisfies AgentMcpAccessRecord;
  store.set(ALL_PROJECTS_STORE_KEY, all);

  pluginMcpGrantRegistry.revokeDisallowedForPlugin(pluginInstanceId, isPluginMcpGrantAllowed);
}
