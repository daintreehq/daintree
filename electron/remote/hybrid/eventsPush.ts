import { CHANNELS } from "../../ipc/channels.js";
import { EVENT_LOCALITY, getChannelLocality } from "../../ipc/channelLocality.js";

/**
 * Hybrid push channels and which machine a remote-bound view takes them from.
 * `events:push` is decided per event instead (see {@link eventsPushSource}).
 * - `shell`: this machine's own state (keep-awake is held per machine, a
 *   config import or project/scratch switch here is about this window).
 * - `both`: meaningful from either side (a config reload on the host changes
 *   the agent registry; one here changes menus and the keymap).
 */
const HYBRID_PUSH_SOURCE: Readonly<Record<string, "shell" | "both">> = {
  [CHANNELS.KEEP_AWAKE_STATE_CHANGED]: "shell",
  [CHANNELS.CONFIG_BUNDLE_IMPORTED]: "shell",
  [CHANNELS.PROJECT_ON_SWITCH]: "shell",
  [CHANNELS.SCRATCH_ON_SWITCH]: "shell",
  [CHANNELS.APP_CONFIG_RELOADED]: "both",
};

type Source = "host" | "shell" | "both" | null;

/**
 * Where an `events:push` envelope must come from for a remote-bound view:
 * host events from the host, Shell events from here. An event name nobody
 * classified is dropped from both, never guessed.
 */
export function eventsPushSource(args: readonly unknown[]): Source {
  const envelope = args[0];
  if (!envelope || typeof envelope !== "object") return null;
  const name = (envelope as { name?: unknown }).name;
  if (typeof name !== "string" || !Object.hasOwn(EVENT_LOCALITY, name)) return null;
  const locality = EVENT_LOCALITY[name];
  return locality === "host" || locality === "shell" ? locality : null;
}

function pushSource(channel: string, args: readonly unknown[]): Source {
  if (channel === CHANNELS.EVENTS_PUSH) return eventsPushSource(args);
  const locality = getChannelLocality(channel);
  if (locality === "host" || locality === "shell") return locality;
  if (locality === "hybrid") {
    return Object.hasOwn(HYBRID_PUSH_SOURCE, channel) ? HYBRID_PUSH_SOURCE[channel]! : null;
  }
  return null;
}

/**
 * A push that arrived from a host for one of its views. Shell channels and
 * Shell-owned halves of hybrid ones are this machine's to say, so a host's
 * copy is dropped.
 */
export function acceptHostPush(channel: string, args: readonly unknown[]): boolean {
  const source = pushSource(channel, args);
  return source === "host" || source === "both";
}

/**
 * A push produced on this machine, about to reach a view bound to a remote
 * host. This machine's agents, terminals and projects are not that view's,
 * so only Shell-owned pushes reach it. Channels with no classification keep
 * today's delivery rather than silently going dark.
 */
export function acceptLocalPushForRemoteView(channel: string, args: readonly unknown[]): boolean {
  if (channel === CHANNELS.EVENTS_PUSH) return eventsPushSource(args) === "shell";
  const locality = getChannelLocality(channel);
  if (locality === null) return true;
  const source = pushSource(channel, args);
  return source === "shell" || source === "both";
}
