import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { MAX_RELAY_ARGS_BYTES, SenderCredentialSchema } from "../assistant/linkMethods.js";
import { DEFAULT_ENCODING_LIMITS, LONE_SURROGATE } from "../link/encoding.js";
import { SEND_TO_AGENT_MAX_ID_LENGTH } from "../../services/plugin/sendToAgentLimits.js";

/**
 * Session-level methods a Shell's installed plugins reach a host through
 * (#16767), apart from everything its assistants use: no MCP session, relay
 * principal, help session or confirmations preference. Each call proves which
 * Shell sent it with that Shell's plugin credential for the host, and names
 * the plugin as the Shell's main process knows it. A host from before these
 * answers UNSUPPORTED.
 */
export const PluginControlMethod = {
  /** Shell → Host: run one built-in action in one of the host's projects for a plugin. */
  DISPATCH: "plugin-control.dispatch",
  /** Shell → Host: interrupt, press keys in or submit to an agent that plugin launched there. */
  AGENT_INPUT: "plugin-control.agent-input",
} as const;

/** What a plugin credential is derived under, so it never doubles as the assistant's. */
const PLUGIN_CREDENTIAL_LABEL = "daintree/plugin-control/v1";

/**
 * The credential this Shell's plugins prove themselves to a host with: derived
 * one-way from the Shell's own secret for that host, so it needs nothing more
 * kept, goes when the host is removed, and never lets its holder present the
 * assistant's credential.
 */
export function pluginCredentialFor(shellSecret: string): string {
  return createHmac("sha256", shellSecret)
    .update(PLUGIN_CREDENTIAL_LABEL, "utf8")
    .digest("base64url");
}

/**
 * The Shell a plugin call came from, as the host derives it: one-way, and in a
 * namespace of its own, so it is never an assistant sender's id.
 */
export function pluginSenderIdFor(credential: string): string {
  return createHash("sha256").update(`daintree.plugin-sender\0${credential}`, "utf8").digest("hex");
}

const id = z.string().min(1).max(256);
/** An installed plugin's id, as the Shell's main process holds it. */
const pluginId = z.string().min(1).max(256);
const terminalId = z.string().min(1).max(SEND_TO_AGENT_MAX_ID_LENGTH);

/**
 * How deep a plugin call's arguments may nest: the link encoder's ceiling,
 * less the frame and payload levels they ride inside.
 */
const MAX_ARGS_DEPTH = DEFAULT_ENCODING_LIMITS.maxDepth - 8;

/** What the link encoder writes for a string: a tag, a length, and UTF-8 or, with a lone surrogate, UTF-16. */
function encodedStringBytes(value: string): number {
  return 5 + (LONE_SURROGATE.test(value) ? value.length * 2 : Buffer.byteLength(value, "utf8"));
}

/**
 * Whether a plugin's call arguments are plain JSON the link can carry within
 * the relay's bound: no Map, Set, Date, bigint, function, class instance,
 * non-finite number or lone-surrogate key, nested no deeper than the encoder
 * allows. The size charged for each value is at least what the link encoder
 * writes for it (`electron/remote/link/encoding.ts`), keys of `undefined`
 * fields included, so what passes is what is sent. Every value visited is
 * charged, so the walk stops as soon as the bound is passed: a cycle (a
 * worker's structured clone keeps them) or a shared value costs each time it
 * is reached.
 */
export function isPluginControlArgs(args: unknown): boolean {
  let bytes = 0;
  const charge = (n: number): boolean => (bytes += n) <= MAX_RELAY_ARGS_BYTES;
  const pending: Array<[value: unknown, depth: number]> = [[args, 0]];
  while (pending.length > 0) {
    const [value, depth] = pending.pop()!;
    if (depth > MAX_ARGS_DEPTH) return false;
    if (value === undefined || value === null || typeof value === "boolean") {
      if (!charge(1)) return false;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || !charge(9)) return false;
      continue;
    }
    if (typeof value === "string") {
      if (!charge(encodedStringBytes(value))) return false;
      continue;
    }
    if (typeof value !== "object" || !charge(5)) return false;
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) {
        if (!charge(1)) return false;
        pending.push([item, depth + 1]);
      }
      continue;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (LONE_SURROGATE.test(key)) return false;
      if (!charge(4 + Buffer.byteLength(key, "utf8"))) return false;
      pending.push([(value as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return true;
}

/** Longest a plugin's call may run on a host before the Shell stops waiting. */
export const PLUGIN_CONTROL_CALL_MS = 60_000;

export const PluginControlDispatchPayloadSchema = z
  .object({
    credential: SenderCredentialSchema,
    pluginId,
    projectId: id,
    actionId: z.string().min(1).max(256),
    // The Shell sends only plain JSON; anything else is refused, never thrown.
    args: z.unknown().optional().refine(isPluginControlArgs),
  })
  .strict();
export type PluginControlDispatchPayload = z.infer<typeof PluginControlDispatchPayloadSchema>;

// A union, not a discriminated one: `sendKeys` comes in two shapes.
export const PluginControlAgentInputSchema = z.union([
  z.object({ op: z.literal("interrupt") }).strict(),
  z
    .object({ op: z.literal("sendKeys"), keys: z.array(z.string().min(1).max(64)).min(1).max(16) })
    .strict(),
  z.object({ op: z.literal("sendKeys"), choose: z.string().min(1).max(200) }).strict(),
  z
    .object({
      op: z.literal("submit"),
      text: z
        .string()
        .min(1)
        .max(256 * 1024),
    })
    .strict(),
]);
export type PluginControlAgentInput = z.infer<typeof PluginControlAgentInputSchema>;

export const PluginControlAgentInputPayloadSchema = z
  .object({
    credential: SenderCredentialSchema,
    pluginId,
    terminalId,
    input: PluginControlAgentInputSchema,
  })
  .strict();
export type PluginControlAgentInputPayload = z.infer<typeof PluginControlAgentInputPayloadSchema>;

/**
 * What an agent input call did on the host: the plugin API's own answers, plus
 * `driven-elsewhere` while another machine (or a window on the host) drives
 * the agent's project, which the Shell turns into the plugin API's
 * `DRIVEN_ELSEWHERE:` rejection.
 */
export const PluginControlAgentInputAnswerSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("sent"),
      cancelKey: z.enum(["advertised", "unverified"]).optional(),
      keys: z.array(z.string().max(256)).max(16).optional(),
    })
    .strip(),
  z.object({ status: z.literal("refused"), reason: z.string().max(4096) }).strip(),
  z.object({ status: z.literal("not-found") }).strip(),
  z.object({ status: z.literal("unavailable") }).strip(),
  z
    .object({ status: z.literal("driven-elsewhere"), holderName: z.string().max(256).nullable() })
    .strip(),
]);
export type PluginControlAgentInputAnswer = z.infer<typeof PluginControlAgentInputAnswerSchema>;
