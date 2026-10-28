import type { AgentDirectory } from "../agentDirectory.js";
import type { HostId } from "../remoteHosts.js";
import type { CanopySnapshot, CanopyTerminalData } from "./canopy.js";
import type { FleetSnapshot } from "./fleet.js";
import type { IpcInvokeMap } from "./maps.js";

/**
 * The Canopy calls a view can make on a host other than its own: its reads,
 * the inbox actions it takes on runs there, and typing into, sizing and
 * answering the run it shows. Those writes are held to that host's drive
 * lease, as a window on it would be.
 */
export const CANOPY_HOST_CHANNELS = [
  "canopy:get-snapshot",
  "canopy:set-active",
  "canopy:refresh",
  "canopy:reread",
  "canopy:trash",
  "canopy:untrash",
  "canopy:restore-trashed",
  "canopy:remove-trashed",
  "canopy:empty-trash",
  "canopy:rename",
  "canopy:archive",
  "canopy:unarchive",
  "canopy:mark-seen",
  "canopy:set-read",
  "canopy:mark-all-read",
  "canopy:restore-reads",
  "canopy:set-scope",
  "canopy:set-shown",
  "canopy:run-branch",
  "canopy:search-screens",
  "canopy:watch-terminal",
  "canopy:unwatch-terminal",
  "canopy:terminal-input",
  "canopy:terminal-resize",
  "canopy:terminal-submit",
  "canopy:terminal-send-key",
  "canopy:answer",
  "canopy:set-mode",
  "canopy:retry-model",
  "fleet:get-snapshot",
] as const;

export type CanopyHostChannel = (typeof CANOPY_HOST_CHANNELS)[number];

/** What any allowed call answers; the renderer's client narrows it by channel. */
export type CanopyHostResult = IpcInvokeMap[CanopyHostChannel]["result"];

const CANOPY_HOST_CHANNEL_SET: ReadonlySet<string> = new Set(CANOPY_HOST_CHANNELS);

export function isCanopyHostChannel(channel: unknown): channel is CanopyHostChannel {
  return typeof channel === "string" && CANOPY_HOST_CHANNEL_SET.has(channel);
}

/** What a host pushes to a Canopy view reading it, as the channels it pushes on. */
export const CANOPY_HOST_PUSH_CHANNELS = [
  "canopy:snapshot-updated",
  "fleet:snapshot-updated",
  "canopy:terminal-data",
] as const;

export type CanopyHostPushChannel = (typeof CANOPY_HOST_PUSH_CHANNELS)[number];

const CANOPY_HOST_PUSH_CHANNEL_SET: ReadonlySet<string> = new Set(CANOPY_HOST_PUSH_CHANNELS);

export function isCanopyHostPushChannel(channel: unknown): channel is CanopyHostPushChannel {
  return typeof channel === "string" && CANOPY_HOST_PUSH_CHANNEL_SET.has(channel);
}

/**
 * The calls a person's assistant viewer makes on the host the assistant runs
 * on (#14163): watching the one assistant they chose, by its exact subject,
 * asking where it would open, and typing to it through that stream. Separate
 * from Canopy's own calls, so it needs no Canopy consent and a host that
 * predates it says so rather than misreading the call.
 */
export const ASSISTANT_VIEWER_CHANNELS = [
  "canopy:watch-assistant-terminal",
  "canopy:resolve-assistant",
  "canopy:unwatch-terminal",
  "canopy:terminal-input",
  "canopy:terminal-submit",
  "canopy:terminal-send-key",
] as const;

export type AssistantViewerChannel = (typeof ASSISTANT_VIEWER_CHANNELS)[number];

export type AssistantViewerResult = IpcInvokeMap[AssistantViewerChannel]["result"];

const ASSISTANT_VIEWER_CHANNEL_SET: ReadonlySet<string> = new Set(ASSISTANT_VIEWER_CHANNELS);

export function isAssistantViewerChannel(channel: unknown): channel is AssistantViewerChannel {
  return typeof channel === "string" && ASSISTANT_VIEWER_CHANNEL_SET.has(channel);
}

/** The assistant viewer protocol a host speaks; a host without it has none. */
export const ASSISTANT_VIEWER_VERSION = 1;

/**
 * The assistants one host holds, as this Shell read them for a person's
 * picker. `version` is the host's assistant viewer protocol, null when the
 * host has none: its workers still read through Canopy, its assistants don't.
 */
export interface HostAssistantDirectory {
  hostId: HostId;
  version: number | null;
  directory: AgentDirectory;
}

/**
 * A push from a host a view reads through Canopy without being bound to it.
 * `hostId` is the id this Shell knows the host by, never one the host sent.
 * `resync` says the link to it came back: what was pushed meanwhile is lost,
 * and the panel's state there (open, scope, shown rows, watch) was dropped
 * with it, so the view reads and says it again.
 *
 * The `assistant-` kinds are one assistant viewer's, named by the consumer the
 * view gave it: its stream's bytes, and that its watch there was lost.
 */
export type CanopyHostEvent =
  | { kind: "canopy-snapshot"; hostId: HostId; snapshot: CanopySnapshot }
  | { kind: "fleet-snapshot"; hostId: HostId; snapshot: FleetSnapshot }
  | { kind: "terminal-data"; hostId: HostId; chunk: CanopyTerminalData }
  | { kind: "resync"; hostId: HostId }
  | { kind: "assistant-terminal-data"; hostId: HostId; consumer: string; chunk: CanopyTerminalData }
  | { kind: "assistant-resync"; hostId: HostId; consumer: string };
