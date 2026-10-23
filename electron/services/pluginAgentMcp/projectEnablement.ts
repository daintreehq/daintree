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
  projectDefaultGroups,
  refreshProjectMcpDefaults,
} from "./projectDefaults.js";
import {
  DATABASE_ENDPOINT_ID,
  DATABASE_WRITES_ACCESS_ID,
  type AgentMcpToolGroupRef,
  type AgentMcpToolScope,
  type DeclaredAgentMcpPlugin,
} from "./types.js";

/**
 * How much of each plugin's agent tools the user lets agents use: off, the
 * host's read-only database tools, or those, the plugin's declared database
 * writes and its own tools. Three
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
 * A plugin whose endpoint declares tool groups is answered for twice in one
 * record: `access` for the host's database tools, as for any plugin, and
 * `groups` for the plugin's own tools, one group at a time. No level reaches a
 * grouped endpoint, so an answer kept from before the plugin declared groups —
 * read and write included — allows none of them until the user picks some.
 * Each choice keeps what the plugin said the group does when it was made, so a
 * group the plugin later recasts from reading to writing is off again.
 *
 * No in-memory copy, matching `projectSurfaceChoices.ts` — reads happen once per
 * terminal launch and per agent request, writes on a click.
 */
const LEGACY_STORE_KEY = "projectAgentMcpEnablement";
const PROJECT_STORE_KEY = "projectAgentMcpAccess";
const ALL_PROJECTS_STORE_KEY = "pluginAgentMcpAccess";
/**
 * How much of a plugin's agent tools the project's Daintree Assistant may use
 * (`projectId → pluginInstanceId → { decidedAt, access }`). A fourth answer,
 * kept apart from the three above because nothing but the user's own click
 * sets it: no repository default and no all-projects answer reach it, and with
 * nothing on record it is off. It caps rather than grants: an Assistant grant
 * reaches only what this project's terminal agents could reach as well.
 */
const ASSISTANT_STORE_KEY = "projectAssistantAgentMcpAccess";

/**
 * One tool group an answer allows. `access` is what the plugin said the group
 * does when the user allowed it; absent only for a group a repository's
 * `.daintree/mcp.json` names, which allows the group whatever it says.
 */
export interface AgentMcpGroupChoice {
  id: string;
  access?: AgentMcpToolGroupRef["access"];
}

export interface AgentMcpAccessRecord {
  decidedAt: number;
  /** Null (project answers only) means "follow the default for every project". */
  access: AgentMcpAccess | null;
  /** The tool groups allowed, for a plugin whose endpoint declares them. None allowed when absent. */
  groups?: AgentMcpGroupChoice[];
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

const MAX_GROUP_CHOICES = 64;

/** The well-formed group choices in a stored list; anything else in it allows nothing. */
function groupChoices(value: unknown): AgentMcpGroupChoice[] {
  if (!Array.isArray(value)) return [];
  const choices: AgentMcpGroupChoice[] = [];
  for (const raw of value.slice(0, MAX_GROUP_CHOICES)) {
    const dict = asDict(raw);
    const id = own(dict, "id");
    const access = own(dict, "access");
    if (typeof id !== "string" || id.length === 0) continue;
    if (access !== "read" && access !== "write") continue;
    choices.push({ id, access });
  }
  return choices;
}

/** Only a well-formed record counts: the file is user-editable. */
function accessRecord(value: unknown): AgentMcpAccessRecord | null {
  const dict = asDict(value);
  if (dict === null || typeof own(dict, "decidedAt") !== "number") return null;
  const access = own(dict, "access");
  if (access !== null && !isAccess(access)) return null;
  const groups = groupChoices(own(dict, "groups"));
  return {
    decidedAt: dict.decidedAt as number,
    access,
    ...(groups.length > 0 ? { groups } : {}),
  };
}

/** Whether a record lets agents reach anything: a level above off, or a group. */
function recordAllowsSomething(record: AgentMcpAccessRecord | null): boolean {
  if (record === null || record.access === null) return false;
  return record.access !== "off" || (record.groups?.length ?? 0) > 0;
}

/** Whether a list of choices allows a declared group, as the plugin declares it now. */
export function choicesAllowGroup(
  choices: readonly AgentMcpGroupChoice[],
  group: AgentMcpToolGroupRef
): boolean {
  return choices.some(
    (choice) =>
      choice.id === group.id && (choice.access === undefined || choice.access === group.access)
  );
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
    .filter(
      ([endpointId, record]) => endpointId !== DATABASE_WRITES_ACCESS_ID && isLegacyRecord(record)
    )
    .map(([endpointId]) => endpointId);
}

/**
 * The tool groups the answer governing a plugin in this project allows, in
 * the same order of precedence as its level: the user's answer for the
 * project, else for an installed plugin their answer for every project, else
 * for a project plugin the repository's. Answers kept one endpoint at a time
 * predate groups and allow none — and, as for a level, still stand in front of
 * every default below them until the user answers again.
 */
export function agentMcpGroupChoices(
  projectId: string,
  pluginInstanceId: string
): readonly AgentMcpGroupChoice[] {
  const project = accessRecord(
    own(asDict(own(read(PROJECT_STORE_KEY), projectId)), pluginInstanceId)
  );
  if (project !== null && project.access !== null) return project.groups ?? [];
  if (project === null && hasLegacyAgentMcpAnswer(projectId, pluginInstanceId)) return [];
  if (projectIdFromPluginInstanceKey(pluginInstanceId) !== null) {
    return (projectDefaultGroups(projectId, pluginInstanceId) ?? []).map((id) => ({ id }));
  }
  const allProjects = accessRecord(own(read(ALL_PROJECTS_STORE_KEY), pluginInstanceId));
  return allProjects !== null && allProjects.access !== null ? (allProjects.groups ?? []) : [];
}

/** The tool groups an installed plugin's every-project answer allows; none for a project plugin. */
export function allProjectsAgentMcpGroupChoices(
  pluginInstanceId: string
): readonly AgentMcpGroupChoice[] {
  if (projectIdFromPluginInstanceKey(pluginInstanceId) !== null) return [];
  const record = accessRecord(own(read(ALL_PROJECTS_STORE_KEY), pluginInstanceId));
  return record !== null && record.access !== null ? (record.groups ?? []) : [];
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
  // Declared writes postdate the answers kept one endpoint at a time, so none
  // of those can speak for them.
  if (answer === undefined && endpointId !== DATABASE_WRITES_ACCESS_ID) {
    const legacy = legacyAnswer(projectId, pluginInstanceId, endpointId);
    if (legacy !== null) return legacy;
  }
  return isAgentMcpEndpointEnabledByDefault(projectId, pluginInstanceId, endpointId);
}

/** The declared groups of an endpoint that a list of choices allows. */
function allowedGroups(
  declared: readonly AgentMcpToolGroupRef[],
  choices: readonly AgentMcpGroupChoice[]
): AgentMcpToolGroupRef[] {
  return declared
    .filter((group) => choicesAllowGroup(choices, group))
    .map((group) => ({ id: group.id, access: group.access }));
}

/** The rosters a new grant for this plugin may reach in the project, or null for none. */
export function agentMcpScopeFor(
  projectId: string,
  plugin: DeclaredAgentMcpPlugin
): AgentMcpToolScope | null {
  const id = plugin.pluginInstanceId;
  const databases =
    plugin.hasDatabases && isAgentMcpEndpointEnabled(projectId, id, DATABASE_ENDPOINT_ID);
  const databaseWrites =
    databases &&
    plugin.hasDatabaseWrites === true &&
    isAgentMcpEndpointEnabled(projectId, id, DATABASE_WRITES_ACCESS_ID);
  const endpoint = plugin.pluginEndpoint;
  // A grouped endpoint is reached through the groups allowed, never a level.
  const pluginGroups =
    endpoint?.groups !== undefined
      ? allowedGroups(endpoint.groups, agentMcpGroupChoices(projectId, id))
      : undefined;
  const pluginEndpointId =
    endpoint === undefined
      ? undefined
      : pluginGroups !== undefined
        ? pluginGroups.length > 0
          ? endpoint.id
          : undefined
        : isAgentMcpEndpointEnabled(projectId, id, endpoint.id)
          ? endpoint.id
          : undefined;
  if (!databases && pluginEndpointId === undefined) return null;
  return {
    databases,
    ...(databaseWrites ? { databaseWrites: true as const } : {}),
    ...(pluginEndpointId !== undefined ? { pluginEndpointId } : {}),
    ...(pluginEndpointId !== undefined && pluginGroups !== undefined ? { pluginGroups } : {}),
  };
}

/**
 * Whether `allows` covers every roster in a scope, and `allowsGroup` every
 * tool group in it. A grouped scope's endpoint is covered by its groups alone.
 */
function isScopeCoveredBy(
  scope: AgentMcpToolScope,
  allows: (endpointId: string) => boolean,
  allowsGroup: (group: AgentMcpToolGroupRef) => boolean
) {
  return (
    (!scope.databases || allows(DATABASE_ENDPOINT_ID)) &&
    (scope.databaseWrites !== true || allows(DATABASE_WRITES_ACCESS_ID)) &&
    (scope.pluginGroups !== undefined
      ? scope.pluginGroups.every(allowsGroup)
      : scope.pluginEndpointId === undefined || allows(scope.pluginEndpointId))
  );
}

/** Whether the project's current access still covers everything in a scope. */
export function isAgentMcpScopeAllowed(
  projectId: string,
  pluginInstanceId: string,
  scope: AgentMcpToolScope
): boolean {
  const choices = scope.pluginGroups ? agentMcpGroupChoices(projectId, pluginInstanceId) : [];
  return isScopeCoveredBy(
    scope,
    (endpointId) => isAgentMcpEndpointEnabled(projectId, pluginInstanceId, endpointId),
    (group) => choicesAllowGroup(choices, group)
  );
}

function assistantRecord(projectId: string, pluginInstanceId: string): AgentMcpAccessRecord | null {
  return accessRecord(own(asDict(own(read(ASSISTANT_STORE_KEY), projectId)), pluginInstanceId));
}

/** The user's answer for the project's Daintree Assistant; off when there is none. */
export function assistantAgentMcpAccess(
  projectId: string,
  pluginInstanceId: string
): AgentMcpAccess {
  return assistantRecord(projectId, pluginInstanceId)?.access ?? "off";
}

/** The tool groups the user allowed the project's Daintree Assistant; none while it is off. */
export function assistantAgentMcpGroupChoices(
  projectId: string,
  pluginInstanceId: string
): readonly AgentMcpGroupChoice[] {
  const record = assistantRecord(projectId, pluginInstanceId);
  return record === null || record.access === "off" ? [] : (record.groups ?? []);
}

/**
 * The part of a terminal scope the Assistant's answer lets it reach: nothing
 * when off; the host's database reads at read only, and at read and write its
 * declared writes and an ungrouped endpoint as well, never the plugin's own
 * tools at read only, which the host can't vouch for. Of a grouped endpoint it
 * reaches only the groups the user allowed the Assistant by name — no level
 * and no description the plugin gives a group stands in for that.
 */
function assistantShareOf(
  scope: AgentMcpToolScope,
  access: AgentMcpAccess,
  choices: readonly AgentMcpGroupChoice[]
): AgentMcpToolScope | null {
  if (access === "off") return null;
  const databaseWrites = access === "read-write" && scope.databaseWrites === true;
  const pluginGroups = scope.pluginGroups?.filter((group) => choicesAllowGroup(choices, group));
  const pluginEndpointId =
    pluginGroups !== undefined
      ? pluginGroups.length > 0
        ? scope.pluginEndpointId
        : undefined
      : access === "read-write"
        ? scope.pluginEndpointId
        : undefined;
  if (!scope.databases && pluginEndpointId === undefined) return null;
  return {
    databases: scope.databases,
    ...(databaseWrites ? { databaseWrites: true as const } : {}),
    ...(pluginEndpointId !== undefined ? { pluginEndpointId } : {}),
    ...(pluginEndpointId !== undefined && pluginGroups !== undefined ? { pluginGroups } : {}),
  };
}

/**
 * The rosters a new Assistant grant for this plugin may reach in the project,
 * or null for none: what this project's terminal agents could reach, narrowed
 * to the user's answer for the Assistant.
 */
export function assistantAgentMcpScopeFor(
  projectId: string,
  plugin: DeclaredAgentMcpPlugin
): AgentMcpToolScope | null {
  const scope = agentMcpScopeFor(projectId, plugin);
  if (scope === null) return null;
  const id = plugin.pluginInstanceId;
  return assistantShareOf(
    scope,
    assistantAgentMcpAccess(projectId, id),
    assistantAgentMcpGroupChoices(projectId, id)
  );
}

/** Whether both the project's access and the Assistant's answer still cover everything in a scope. */
export function isAssistantAgentMcpScopeAllowed(
  projectId: string,
  pluginInstanceId: string,
  scope: AgentMcpToolScope
): boolean {
  if (!isAgentMcpScopeAllowed(projectId, pluginInstanceId, scope)) return false;
  const access = assistantAgentMcpAccess(projectId, pluginInstanceId);
  const choices = assistantAgentMcpGroupChoices(projectId, pluginInstanceId);
  return isScopeCoveredBy(
    scope,
    (endpointId) => accessAllowsEndpoint(access, endpointId),
    (group) => choicesAllowGroup(choices, group)
  );
}

/**
 * Whether a grant's scope is still allowed: by the project's access, and for
 * an Assistant grant by the Assistant's answer as well, so lowering either one
 * revokes it.
 */
export function isPluginMcpGrantAllowed(grant: PluginMcpGrant): boolean {
  return grant.consumer === "assistant"
    ? isAssistantAgentMcpScopeAllowed(grant.projectId, grant.pluginInstanceId, grant.scope)
    : isAgentMcpScopeAllowed(grant.projectId, grant.pluginInstanceId, grant.scope);
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
    if (recordAllowsSomething(accessRecord(raw))) ids.add(id);
  }
  const legacy = asDict(own(read(LEGACY_STORE_KEY), projectId));
  for (const [id, raw] of Object.entries(legacy ?? {})) {
    if (projectAgentMcpAccessAnswer(projectId, id) !== undefined) continue;
    if (Object.values(asDict(raw) ?? {}).some(isLegacyOn)) ids.add(id);
  }
  for (const [id, raw] of Object.entries(read(ALL_PROJECTS_STORE_KEY))) {
    if (projectIdFromPluginInstanceKey(id) !== null) continue;
    if (recordAllowsSomething(accessRecord(raw))) ids.add(id);
  }
  return [...ids];
}

/**
 * Every plugin instance the project's Daintree Assistant has an answer on
 * record for that lets it reach something, whether or not that plugin is
 * running now or this project's agents can reach it — so settings can keep
 * that answer visible and revocable too.
 */
export function listAssistantAgentMcpAccessInstances(projectId: string): string[] {
  const project = asDict(own(read(ASSISTANT_STORE_KEY), projectId));
  return Object.entries(project ?? {})
    .filter(([, raw]) => {
      const access = accessRecord(raw)?.access;
      return access !== undefined && access !== null && access !== "off";
    })
    .map(([id]) => id);
}

/** Whether the project's Assistant could reach any plugin, so an Assistant launch with none never loads PluginService. */
export function hasAnyAssistantAgentMcpAccess(projectId: string): boolean {
  return listAssistantAgentMcpAccessInstances(projectId).length > 0;
}

/**
 * Whether anything could be on for this project — an answer or a repository
 * default — so a launch in a project with neither never loads PluginService.
 */
export function hasAnyAgentMcpEnablement(projectId: string): boolean {
  return listAgentMcpAccessInstances(projectId).length > 0 || hasProjectMcpDefaults(projectId);
}

/** A record to store. Group choices keep the class they were made under; one without is never stored. */
function recordOf(
  decidedAt: number,
  access: AgentMcpAccess | null,
  groups: readonly AgentMcpGroupChoice[] | undefined
): AgentMcpAccessRecord {
  const kept = (groups ?? []).filter(
    (group): group is Required<AgentMcpGroupChoice> => group.access !== undefined
  );
  return {
    decidedAt,
    access,
    ...(kept.length > 0 ? { groups: kept.map(({ id, access }) => ({ id, access })) } : {}),
  };
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
  now: number = Date.now(),
  groups?: readonly AgentMcpGroupChoice[]
): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("agent MCP: projectId must be a project workspace id");
  }
  if (!pluginInstanceId) throw new Error("agent MCP: plugin id is required");

  // A read failure propagates: this rewrites the whole key, so writing from a
  // map we could not read would drop every other project's answers.
  const all = copy(read(PROJECT_STORE_KEY));
  const project = copy(asDict(own(all, projectId)));
  project[pluginInstanceId] = recordOf(
    now,
    access,
    access === null ? undefined : (groups ?? accessRecord(own(project, pluginInstanceId))?.groups)
  );
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
  now: number = Date.now(),
  groups?: readonly AgentMcpGroupChoice[]
): void {
  if (!pluginInstanceId) throw new Error("agent MCP: plugin id is required");
  if (projectIdFromPluginInstanceKey(pluginInstanceId) !== null) {
    throw new Error("agent MCP: only an installed plugin has an answer for every project");
  }
  const all = copy(read(ALL_PROJECTS_STORE_KEY));
  if (access === null) delete all[pluginInstanceId];
  else {
    all[pluginInstanceId] = recordOf(
      now,
      access,
      groups ?? accessRecord(own(all, pluginInstanceId))?.groups
    );
  }
  store.set(ALL_PROJECTS_STORE_KEY, all);

  pluginMcpGrantRegistry.revokeDisallowedForPlugin(pluginInstanceId, isPluginMcpGrantAllowed);
}

/**
 * Record the user's answer for the project's Daintree Assistant; off removes
 * it. Anything it takes away is revoked at once for the Assistant, which loses
 * the plugin's server on its next request; anything it adds reaches Assistant
 * sessions launched afterwards, never past what the project's agents have.
 */
export function setProjectAssistantAgentMcpAccess(
  projectId: string,
  pluginInstanceId: string,
  access: AgentMcpAccess,
  now: number = Date.now(),
  groups?: readonly AgentMcpGroupChoice[]
): void {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("agent MCP: projectId must be a project workspace id");
  }
  if (!pluginInstanceId) throw new Error("agent MCP: plugin id is required");

  const all = copy(read(ASSISTANT_STORE_KEY));
  const project = copy(asDict(own(all, projectId)));
  if (access === "off") delete project[pluginInstanceId];
  else {
    project[pluginInstanceId] = recordOf(
      now,
      access,
      groups ?? accessRecord(own(project, pluginInstanceId))?.groups
    );
  }
  if (Object.keys(project).length > 0) all[projectId] = project;
  else delete all[projectId];
  store.set(ASSISTANT_STORE_KEY, all);

  pluginMcpGrantRegistry.revokeDisabledInProject(
    projectId,
    (grant) => grant.pluginInstanceId !== pluginInstanceId || isPluginMcpGrantAllowed(grant)
  );
}
