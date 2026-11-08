import { isBuiltInAgentId, type BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { AGENT_REGISTRY, type AgentConfig } from "../../../shared/config/agentRegistry.js";
import { getPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import { getPluginProcessToolRegistry } from "../../../shared/config/pluginProcessToolRegistry.js";
import type { AgentId } from "../../../shared/types/agent.js";
import { PROCESS_TOOL_ICON_BY_COMMAND } from "../../../shared/config/processToolRegistry.js";

/**
 * Is this package tail specific enough to stand alone as an agent name?
 *
 * The tail is a convenience alias, so it only earns registration when it
 * actually names its agent: one of its alphanumeric tokens must be the
 * agent's id or command. `@anthropic-ai/claude-code` → `claude-code` keeps its
 * alias; `@ampcode/cli` → `cli` loses it, because nothing about `cli` says
 * Amp, and registering it made every Node CLI launched as `node …/cli.js` —
 * `npx electron .` among them — resolve to that agent. #11931
 */
function isAgentSpecificTail(tail: string, id: string, command: string): boolean {
  const tokens = tail.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.includes(id.toLowerCase()) || tokens.includes(command.toLowerCase());
}

function packageTail(pkg: string | undefined): string | undefined {
  if (!pkg) return undefined;
  const tail = pkg.split("/").pop();
  return tail && tail.length > 0 ? tail : undefined;
}

/** Reads `packages.npm` first; falls back to deprecated top-level `npmGlobalPackage`. */
function effectiveNpmPackage(config: {
  packages?: { npm?: string };
  npmGlobalPackage?: string;
}): string | undefined {
  return config.packages?.npm ?? config.npmGlobalPackage;
}

/**
 * Command name → built-in agent id. Null-prototype: this map is indexed by a
 * name read off a live process, and on a plain object a process named
 * `constructor` or `toString` would resolve to an inherited function and be
 * treated as a detected agent.
 */
export const AGENT_CLI_NAMES: Record<string, BuiltInAgentId> = Object.assign(
  Object.create(null) as Record<string, BuiltInAgentId>,
  Object.fromEntries(
    Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
      const entries: [string, BuiltInAgentId][] = [[config.command, id as BuiltInAgentId]];
      if (config.command !== id) {
        entries.push([id, id as BuiltInAgentId]);
      }
      const tail = packageTail(effectiveNpmPackage(config));
      if (
        tail &&
        tail !== config.command &&
        tail !== id &&
        isAgentSpecificTail(tail, id, config.command)
      ) {
        entries.push([tail, id as BuiltInAgentId]);
      }
      return entries;
    })
  )
);

/** The shape main's manifest schema gives a plugin agent's executable name. */
const PLUGIN_EXECUTABLE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_EXECUTABLE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

let cachedAgentSnapshot: Record<string, AgentConfig> | null = null;
let cachedAgentCliNames: Readonly<Record<string, AgentId>> = AGENT_CLI_NAMES;
let cachedPluginAgentIds: ReadonlySet<string> = new Set();

/**
 * Rebuild the plugin half of the agent name lookup when the plugin agent
 * snapshot changes. Main has already resolved each agent's names and dropped
 * the contested ones; this re-checks what the pty-host can cheaply check,
 * because the invariant is the detector's to keep: a built-in agent or tool
 * name never promotes to a plugin agent, and a name two agents claim promotes
 * to neither.
 */
function refreshAgentNameCache(): void {
  const snapshot = getPluginAgentRegistry();
  if (snapshot === cachedAgentSnapshot) return;
  cachedAgentSnapshot = snapshot;

  const pluginNames = Object.create(null) as Record<string, AgentId>;
  const contested = new Set<string>();
  for (const [agentId, config] of Object.entries(snapshot)) {
    if (isBuiltInAgentId(agentId) || !Array.isArray(config?.executableNames)) continue;
    for (const name of config.executableNames) {
      if (typeof name !== "string" || !PLUGIN_EXECUTABLE_NAME_PATTERN.test(name)) continue;
      if (RESERVED_EXECUTABLE_NAMES.has(name)) continue;
      if (Object.hasOwn(AGENT_CLI_NAMES, name)) continue;
      if (Object.hasOwn(PROCESS_TOOL_ICON_BY_COMMAND, name)) continue;
      if (Object.hasOwn(pluginNames, name) && pluginNames[name] !== agentId) {
        contested.add(name);
      } else {
        pluginNames[name] = agentId;
      }
    }
  }
  for (const name of contested) delete pluginNames[name];

  const pluginAgentIds = new Set(Object.values(pluginNames));
  cachedPluginAgentIds = pluginAgentIds;
  cachedAgentCliNames =
    pluginAgentIds.size === 0
      ? AGENT_CLI_NAMES
      : Object.assign(Object.create(null) as Record<string, AgentId>, pluginNames, AGENT_CLI_NAMES);
}

/**
 * Command name → agent id for every name that promotes a terminal: the
 * built-in {@link AGENT_CLI_NAMES} plus each plugin agent's executable names
 * (#16469). A function for the same reason as {@link getProcessIconMap}: the
 * plugin layer arrives over IPC after this module loads. Cached against the
 * plugin agent snapshot's identity, and with no plugin agent claiming a name
 * it is the built-in map itself.
 */
export function getAgentCliNames(): Readonly<Record<string, AgentId>> {
  refreshAgentNameCache();
  return cachedAgentCliNames;
}

/**
 * Can a process still be recognised as this agent? True for every built-in
 * and for a plugin agent that holds at least one executable name right now —
 * false once its plugin unloads or another plugin contests its only name,
 * which is what revokes a promotion that agent's name produced.
 */
export function isDetectableAgentId(agentId: string | null | undefined): boolean {
  if (!agentId) return false;
  if (isBuiltInAgentId(agentId)) return true;
  refreshAgentNameCache();
  return cachedPluginAgentIds.has(agentId);
}

/** Command name → icon id derived from `AGENT_REGISTRY`. Built-in agents only. */
const AGENT_ICON_BY_COMMAND: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
    const entries: [string, string][] = [[id, config.iconId]];
    if (config.command !== id) {
      entries.push([config.command, config.iconId]);
    }
    const tail = packageTail(effectiveNpmPackage(config));
    if (
      tail &&
      tail !== config.command &&
      tail !== id &&
      isAgentSpecificTail(tail, id, config.command)
    ) {
      entries.push([tail, config.iconId]);
    }
    return entries;
  })
);

let cachedPluginSnapshot: Record<string, string> | null = null;
let cachedProcessIconMap: Record<string, string> = {};

/**
 * Command name → icon id for every recognized process. Tools come from the
 * shared registry; agent entries are derived from `AGENT_REGISTRY` and spread
 * after them so a command shared with a tool still resolves to the agent.
 *
 * Plugin-contributed detections (#11613) are spread FIRST, so both built-in
 * layers override them. The manifest schema already rejects a plugin command
 * that collides with either, making this defense in depth for anything that
 * reaches the registry without passing the schema.
 *
 * This is a function rather than the module-level const it replaced because the
 * plugin layer arrives over IPC after this module is evaluated — a const would
 * be permanently stale in the pty-host. The merged map is cached against the
 * plugin snapshot's reference identity, which
 * `shared/config/pluginProcessToolRegistry.ts` only replaces on a real
 * mutation, so the rebuild cost is paid per registry change and not per lookup.
 */
export function getProcessIconMap(): Readonly<Record<string, string>> {
  const pluginSnapshot = getPluginProcessToolRegistry();
  if (pluginSnapshot === cachedPluginSnapshot) {
    return cachedProcessIconMap;
  }
  cachedPluginSnapshot = pluginSnapshot;
  cachedProcessIconMap = Object.assign(
    // Null-prototype so a command named `constructor`/`toString` resolves to
    // undefined rather than an inherited member on a plain-object lookup.
    Object.create(null) as Record<string, string>,
    pluginSnapshot,
    PROCESS_TOOL_ICON_BY_COMMAND,
    AGENT_ICON_BY_COMMAND
  );
  return cachedProcessIconMap;
}
