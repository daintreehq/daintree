import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { MAX_RELAY_ARGS_BYTES, SenderCredentialSchema } from "../assistant/linkMethods.js";
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
 * Whether a value is plain JSON: no Map, Set, bigint, function, class instance
 * or non-finite number. The link would carry some of those whole, so a JSON
 * measure of them would not be a measure of what is sent. An `undefined` field
 * is let through, as JSON drops it.
 */
function isPlainJson(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
      continue;
    }
    if (typeof value !== "object") return false;
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    pending.push(...Object.values(value as Record<string, unknown>));
  }
  return true;
}

/** Whether a plugin's call arguments are plain JSON within the relay's bound. */
export function isPluginControlArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!isPlainJson(args)) return false;
  return Buffer.byteLength(JSON.stringify(args), "utf8") <= MAX_RELAY_ARGS_BYTES;
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
