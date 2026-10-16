import type { HostId } from "../remoteHosts.js";
import type { CanopySnapshot, CanopyTerminalData } from "./canopy.js";
import type { FleetSnapshot } from "./fleet.js";
import type { IpcInvokeMap } from "./maps.js";

/**
 * The Canopy calls a view can make on a host other than its own: its reads,
 * and the inbox actions it takes on runs there. Typing into a run, answering
 * it and resizing its terminal are not among them; who may do that from
 * another host is decided separately.
 */
export const CANOPY_HOST_CHANNELS = [
  "canopy:get-snapshot",
  "canopy:set-active",
  "canopy:refresh",
  "canopy:reread",
  "canopy:trash",
  "canopy:untrash",
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
  "canopy:watch-terminal",
  "canopy:unwatch-terminal",
  "canopy:set-mode",
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
 * A push from a host a view reads through Canopy without being bound to it.
 * `hostId` is the id this Shell knows the host by, never one the host sent.
 * `resync` says the link to it came back: what was pushed meanwhile is lost,
 * and the panel's state there (open, scope, shown rows, watch) was dropped
 * with it, so the view reads and says it again.
 */
export type CanopyHostEvent =
  | { kind: "canopy-snapshot"; hostId: HostId; snapshot: CanopySnapshot }
  | { kind: "fleet-snapshot"; hostId: HostId; snapshot: FleetSnapshot }
  | { kind: "terminal-data"; hostId: HostId; chunk: CanopyTerminalData }
  | { kind: "resync"; hostId: HostId };
