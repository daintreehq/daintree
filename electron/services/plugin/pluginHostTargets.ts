import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { PluginRemoteHost } from "../../../shared/types/plugin.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { getPluginCapabilityConsentStore } from "../plugin-capability/instances.js";

/** One input call on an agent a plugin launched on a Remote Host. */
export type PluginHostAgentInput =
  | { op: "interrupt" }
  | { op: "sendKeys"; keys: string[] }
  | { op: "sendKeys"; choose: string }
  | { op: "submit"; text: string };

/**
 * What the host answered: the plugin API's own answers, or `driven-elsewhere`
 * while another machine (or a window on the host) drives the agent's project.
 */
export type PluginHostAgentInputAnswer =
  | { status: "sent"; cancelKey?: "advertised" | "unverified"; keys?: string[] }
  | { status: "refused"; reason: string }
  | { status: "not-found" }
  | { status: "unavailable" }
  | { status: "driven-elsewhere"; holderName: string | null };

/** A call one installed plugin makes to one host; `pluginId` is main's, never the plugin's word. */
export interface PluginHostTarget {
  hostId: string;
  pluginId: string;
}

/**
 * How an installed plugin reaches this machine's Remote Hosts (#16767).
 * Installed by the remote hosts module, since core code never reads a link;
 * absent, this machine drives no hosts.
 */
export interface PluginHostTargets {
  knows(hostId: string): boolean;
  nameOf(hostId: string): string;
  listHosts(): Promise<PluginRemoteHost[]>;
  dispatch(
    target: PluginHostTarget,
    request: { projectId: string; actionId: string; args: unknown }
  ): Promise<ActionDispatchResult>;
  agentInput(
    target: PluginHostTarget,
    terminalId: string,
    input: PluginHostAgentInput
  ): Promise<PluginHostAgentInputAnswer>;
}

let targets: PluginHostTargets | null = null;

export function setPluginHostTargets(next: PluginHostTargets): () => void {
  targets = next;
  return () => {
    if (targets === next) targets = null;
  };
}

export function getPluginHostTargets(): PluginHostTargets | null {
  return targets;
}

/**
 * Whether the user turned on "Allow host targeting" for an installed plugin.
 * Read straight from the grant store: the switch is the only writer, and the
 * JIT consent flow never mints this capability.
 */
export function hasHostTargetingGrant(pluginId: string): boolean {
  return getPluginCapabilityConsentStore().hasGrant({
    pluginId,
    capability: "host:dispatch",
    scopeKey: "global",
  });
}

/**
 * Refuse a call that would reach a Remote Host unless the plugin may (#16767):
 * an installed plugin that declares `host:dispatch` with the user's switch on.
 * The switch is the whole grant: no first-use prompt, so an unattended plugin
 * fails fast instead of waiting on a dialog nobody is there to answer.
 */
export function assertMayTargetHosts(
  declared: ReadonlySet<string>,
  pluginId: string,
  boundProjectId: string | null,
  what: string
): void {
  if (boundProjectId !== null) {
    throw new Error(
      `PERMISSION_REQUIRED: plugin "${pluginId}" is a project plugin, and ${what} reaches Remote Hosts, which only an installed plugin may`
    );
  }
  if (!declared.has("host:dispatch")) {
    throw new Error(
      `PERMISSION_REQUIRED: plugin "${pluginId}" ${what} requires "host:dispatch", which is not declared in manifest.capabilities`
    );
  }
  if (!hasHostTargetingGrant(pluginId)) {
    throw new Error(
      `PERMISSION_REQUIRED: plugin "${pluginId}" ${what} requires "Allow host targeting", which is off. Turn it on in the plugin's Permissions in the Plugin Manager.`
    );
  }
}

/**
 * The host a plugin named, checked for shape. Arrives from an untrusted worker,
 * so an empty or non-string id is refused rather than read as "no host", which
 * would quietly route the call to this machine.
 */
export function parseHostId(pluginId: string, what: string, hostId: unknown): string {
  if (typeof hostId !== "string" || hostId.trim().length === 0 || hostId.length > 256) {
    throw new Error(`Plugin "${pluginId}" ${what}: hostId must be a non-empty string`);
  }
  if (hostId === LOCAL_HOST_ID) {
    throw new Error(
      `Plugin "${pluginId}" ${what}: "${LOCAL_HOST_ID}" is this machine, not a Remote Host; leave hostId out to reach it`
    );
  }
  return hostId;
}
