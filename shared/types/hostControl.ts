import { z } from "zod";

/**
 * This Shell's reach into its Remote Hosts for its own assistants (#13493,
 * #13496): `host.list` to see them, and `host.call` to run one of a host's own
 * Daintree tools there, through the host's own MCP gates. Delegating to a
 * host's assistant is ordinary agent messaging run through `host.call`
 * (`assistant.list`, `assistant.start`, `terminal.sendCommand` with
 * `handback`, notices, the last-message read). Every tool runs in main for one
 * of this machine's own assistants, never through a renderer or a host's MCP key.
 *
 * A tool answers with an `outcome` naming what happened. Only a caller that
 * isn't one of this machine's assistants, or arguments that don't parse, are
 * tool errors; a host that is switched off, unreachable or too old, or a call
 * whose fate isn't known yet, is a result the caller can act on.
 */

export const HOST_LIST_TOOL = "host.list";
/**
 * Runs one of a host's own Daintree tools for this Shell's assistant (#13493),
 * over the link the Shell already holds. Offered from the start of every
 * assistant session in one of this machine's views, hosts or not, since a
 * client that reads its tool list once never learns of a host added later.
 */
export const HOST_CALL_TOOL = "host.call";

export const HOST_CONTROL_TOOL_IDS: ReadonlySet<string> = new Set([HOST_LIST_TOOL, HOST_CALL_TOOL]);

/** Most projects `host.list` names for one host. */
export const HOST_LIST_PROJECTS_MAX = 50;

export const HOST_CONTROL_OUTCOMES = [
  "ok",
  "ambiguous",
  "opted_out",
  "disconnected",
  "unsupported",
  "policy_rejected",
  "expired",
  "not_found",
  "rate_limited",
  "too_large",
  "conflict",
] as const;

export type HostControlOutcomeCode = (typeof HOST_CONTROL_OUTCOMES)[number];

const outcomeSchema = z.enum(HOST_CONTROL_OUTCOMES);
const hostIdSchema = z.string().min(1).max(64).describe("A host id from the host list.");
const idSchema = z.string().min(1).max(256);

const outcomeFields = {
  outcome: outcomeSchema,
  /** Plain words on what the outcome means and what to do next; fixed text. */
  detail: z.string().nullable(),
  /** Set with `rate_limited`: how long until a retry may succeed. */
  retryAfterMs: z.number().nullable(),
};

export const HostListArgsSchema = z.object({});
export type HostListArgs = z.infer<typeof HostListArgsSchema>;

export const HostListEntrySchema = z.object({
  hostId: z.string(),
  name: z.string(),
  connection: z.enum(["connected", "connecting", "disconnected"]),
  rttMs: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  load: z
    .object({
      sampledAt: z.number(),
      cpuPercent: z.number().nullable(),
      memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
      thermal: z.enum(["nominal", "fair", "serious", "critical"]).nullable(),
    })
    .nullable(),
  agentsObserved: z
    .object({ working: z.number(), waiting: z.number(), idle: z.number() })
    .nullable(),
  /** Its projects while connected, most used first: the projectIds `host.call` takes. */
  projects: z.array(z.object({ projectId: z.string(), name: z.string() })).nullable(),
  /** This Shell's "assistant control" switch for the host: whether `host.call` may reach it. */
  control: z.boolean(),
});
export type HostListEntry = z.infer<typeof HostListEntrySchema>;

export const HostListResultSchema = z.object({ hosts: z.array(HostListEntrySchema) });
export type HostListResult = z.infer<typeof HostListResultSchema>;

export const HostCallArgsSchema = z.object({
  hostId: hostIdSchema,
  projectId: idSchema.describe("A projectId from the host list. The call runs there."),
  tool: z
    .string()
    .min(1)
    .max(128)
    .describe("A Daintree tool on the host, by id. Search the host's own tools through this."),
  args: z.record(z.string(), z.unknown()).optional().describe("The tool's own arguments."),
  callId: idSchema
    .optional()
    .describe("Resend an ambiguous call under its callId. It never runs twice."),
});
export type HostCallArgs = z.infer<typeof HostCallArgsSchema>;

/** A host tool's answer, as its own MCP result: structured when it has a schema, else its text. */
const hostCallInnerSchema = z.object({
  isError: z.boolean(),
  structured: z.record(z.string(), z.unknown()).nullable(),
  text: z.string().nullable(),
});
export type HostCallInnerResult = z.infer<typeof hostCallInnerSchema>;

export const HostCallResultSchema = z.object({
  ...outcomeFields,
  callId: z.string().nullable(),
  result: hostCallInnerSchema.nullable(),
});
export type HostCallResult = z.infer<typeof HostCallResultSchema>;

/** Why a host tool refused outright: the caller isn't this machine's assistant, or its arguments don't parse. */
export type HostControlRefusalCode = "NOT_ELIGIBLE" | "INVALID_ARGS" | "UNAVAILABLE";

export type HostControlToolResult = HostListResult | HostCallResult;

export type HostControlOutcome<T> =
  { ok: true; value: T } | { ok: false; code: HostControlRefusalCode; message: string };
