import { CHANNELS } from "../../ipc/channels.js";
import { EVENT_LOCALITY, getChannelLocality } from "../../ipc/channelLocality.js";
import { z } from "zod";
import type { SystemMemoryPressurePayload } from "../../../shared/types/ipc/system.js";

/**
 * Hybrid push channels and which machine a remote-bound view takes them from.
 * `events:push` is decided per event instead (see {@link eventsPushSource}).
 * - `shell`: this machine's own state (keep-awake is held per machine, a
 *   project/scratch switch here is about this window).
 * - `both`: meaningful from either side (a config reload on the host changes
 *   the agent registry; one here changes menus and the keymap; settings
 *   imported here, or copied to the host, change what its windows show).
 */
const HYBRID_PUSH_SOURCE: Readonly<Record<string, "shell" | "both">> = {
  [CHANNELS.KEEP_AWAKE_STATE_CHANGED]: "shell",
  [CHANNELS.CONFIG_BUNDLE_IMPORTED]: "both",
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

/**
 * All such a toast may carry. A host's toast shows in a Shell's view and its
 * buttons run with the user's source, so nothing that adds one crosses the link.
 */
const AGENT_CLI_COPIES_TOAST_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "message",
  "agentCliCopies",
]);

/**
 * Toasts are this machine's to raise, except one reporting the agent CLIs found
 * on a machine: a remote view's agent settings show the host's copies, so that
 * view hears about the host's and never this machine's (#16409).
 */
function isAgentCliCopiesToast(args: readonly unknown[]): boolean {
  const payload = args[0];
  if (!payload || typeof payload !== "object") return false;
  if (!Object.keys(payload).every((field) => AGENT_CLI_COPIES_TOAST_FIELDS.has(field))) {
    return false;
  }
  const notice = (payload as { agentCliCopies?: { agentId?: unknown } }).agentCliCopies;
  return typeof notice?.agentId === "string" && notice.agentId.length > 0;
}

function pushSource(channel: string, args: readonly unknown[]): Source {
  if (channel === CHANNELS.EVENTS_PUSH) return eventsPushSource(args);
  if (channel === CHANNELS.NOTIFICATION_SHOW_TOAST && isAgentCliCopiesToast(args)) return "host";
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
 * The event or channel name of a push this build never classified, as a host
 * on another build sends one it added; null for every push this build knows,
 * including the Shell-owned ones {@link acceptHostPush} drops on purpose.
 */
export function unclassifiedPushName(channel: string, args: readonly unknown[]): string | null {
  if (channel !== CHANNELS.EVENTS_PUSH) {
    return getChannelLocality(channel) === null ? channel : null;
  }
  const envelope = args[0];
  if (!envelope || typeof envelope !== "object") return null;
  const name = (envelope as { name?: unknown }).name;
  return typeof name === "string" && !Object.hasOwn(EVENT_LOCALITY, name) ? name : null;
}

/**
 * A push produced on this machine, about to reach a view bound to a remote
 * host. This machine's agents, terminals and projects are not that view's,
 * so only Shell-owned pushes reach it. A channel with no classification
 * stays here: every real channel has one, so an unknown one is never the
 * remote view's to hear.
 */
export function acceptLocalPushForRemoteView(channel: string, args: readonly unknown[]): boolean {
  if (channel === CHANNELS.EVENTS_PUSH) return eventsPushSource(args) === "shell";
  const locality = getChannelLocality(channel);
  if (locality === null) return false;
  const source = pushSource(channel, args);
  return source === "shell" || source === "both";
}

const nullableNumber = z.number().nullable();

/**
 * What a view can show of a host's episode. Extra fields pass, so a newer host
 * can add one; a changed shape is refused rather than handed to a renderer that
 * would throw on it halfway through raising the notice.
 */
const SystemMemoryEpisodeSchema = z
  .object({
    status: z.enum(["degraded", "normal"]),
    swapUsedPercent: nullableNumber,
    swapKind: z.enum(["swap", "commit"]),
    fseventsdRssMb: nullableNumber,
    kernelPressureLevel: z.enum(["warn", "critical"]).nullable(),
    escalated: z.boolean(),
    workloads: z
      .object({
        appMemoryMb: nullableNumber,
        projects: z.array(
          z.object({
            projectId: z.string().nullable(),
            projectName: z.string().nullable(),
            terminalCount: z.number(),
            memoryMb: z.number(),
          })
        ),
        agentsRunning: nullableNumber,
        memoryTotalMb: nullableNumber,
      })
      .nullable(),
    replay: z.literal(true).optional(),
    episodeId: z.string().nullable().optional(),
  })
  .loose();

/**
 * The memory episode an `events:push` carries: its payload, `"unsupported"`
 * for one whose payload this build can't read, or null for any other push. A
 * host's episode is shown the way this machine's own is, once per window
 * (#18275), so the Shell takes every one out of ordinary per-view routing.
 */
export function systemMemoryEpisodeOf(
  channel: string,
  args: readonly unknown[]
): SystemMemoryPressurePayload | "unsupported" | null {
  if (channel !== CHANNELS.EVENTS_PUSH) return null;
  const envelope = args[0] as { name?: unknown; payload?: unknown } | null | undefined;
  if (!envelope || typeof envelope !== "object" || envelope.name !== "system:memory-pressure") {
    return null;
  }
  const parsed = SystemMemoryEpisodeSchema.safeParse(envelope.payload);
  return parsed.success ? (envelope.payload as SystemMemoryPressurePayload) : "unsupported";
}
