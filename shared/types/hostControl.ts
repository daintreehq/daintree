import { z } from "zod";
import { AgentDirectorySchema } from "./agentDirectory.js";
import { HOST_SETTING_KEYS, HostSettingsPatchFieldsSchema } from "./hostSettings.js";
import { HostThrowawayCallSchema } from "./hostThrowaway.js";

/**
 * This Shell's reach into its Remote Hosts for its own assistants (#13493,
 * #13496): `host.list` to see them, and `host.call` to run one of a host's own
 * Daintree tools there, through the host's own MCP gates. Delegating to a
 * host's assistant is ordinary agent messaging run through `host.call`
 * (`assistant.list`, `assistant.start`, `terminal.sendCommand` with
 * `handback`, notices, the last-message read). Every tool runs in main for one
 * of this machine's own assistants, never through a renderer or a host's MCP key.
 * This machine's own id, `local`, reaches its other projects the same way, in
 * process (#14024).
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
/**
 * Makes sure the calling assistant's project is on a host (#14140), with
 * nobody clicking: the host's own copy found, else cloned there by the host,
 * and the branch's worktree made when asked. Nothing opens or switches in a
 * window, nothing is pushed or sent, no setup recipe runs and no lease is
 * taken; anything that needs the person comes back as a question.
 */
export const HOST_ENSURE_PROJECT_TOOL = "host.ensureProject";

/**
 * Reads and changes a host's own named settings (#14167), such as turning
 * Canopy on across several hosts, with no project or window there. Every
 * change is previewed first and applied only once the person approves exactly
 * that preview, in a dialog this Shell raises; nothing the caller says counts
 * as approval.
 */
export const HOST_SETTINGS_TOOL = "host.settings";

export const HOST_CONTROL_TOOL_IDS: ReadonlySet<string> = new Set([
  HOST_LIST_TOOL,
  HOST_CALL_TOOL,
  HOST_ENSURE_PROJECT_TOOL,
  HOST_SETTINGS_TOOL,
]);

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

export const HostListArgsSchema = z.object({
  includeAgents: z
    .boolean()
    .optional()
    .describe(
      "Also list each host's agents: its workers and Daintree Assistants, as observed. Read the coverage before reading an empty list as nothing running."
    ),
  projectId: idSchema
    .optional()
    .describe(
      "With includeAgents, list only the agents of this project (a projectId from the list)."
    ),
});
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
      ageMs: z.number(),
      stale: z
        .boolean()
        .describe("Too old to trust: the live figures below are null. Not a zero reading."),
      platform: z.enum(["darwin", "linux"]),
      cpuPercent: z.number().nullable(),
      cpuLogicalCores: z.number().nullable(),
      cpuBusyCores: z
        .number()
        .nullable()
        .describe(
          "cpuPercent of the cores it is a share of: all logical cores, or a cgroup quota."
        ),
      cpuIdleCores: z.number().nullable(),
      memoryTotalBytes: z.number().nullable(),
      memoryUsedBytes: z.number().nullable(),
      memoryAvailableBytes: z.number().nullable().describe("Total minus used, as the host counts."),
      memoryCapacityReported: z
        .boolean()
        .describe("False: an older host whose used memory includes file cache, so none is given."),
      memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
      thermal: z.enum(["nominal", "fair", "serious", "critical"]).nullable(),
      metricsScope: z.enum(["host", "cgroup"]).nullable().optional(),
      memoryPressureSomeAvg10: z.number().nullable().optional(),
      temperatureCelsius: z.number().nullable().optional(),
      temperatureZone: z.string().nullable().optional(),
    })
    .nullable()
    .describe("Null: no sample. Any null field inside is unknown, never zero or unlimited."),
  agentsObserved: z
    .object({ working: z.number(), waiting: z.number(), idle: z.number() })
    .nullable(),
  /** Its projects while connected, most used first: the projectIds `host.call` takes. */
  projects: z
    .array(
      z.object({
        projectId: z.string(),
        name: z.string(),
        frontendAttached: z
          .boolean()
          .nullable()
          .describe(
            "A frontend is attached: a view there or a driving Shell. If false, only tools the host runs itself run. Null: unknown."
          ),
      })
    )
    .nullable(),
  /** This Shell's "assistant control" switch for the host: whether `host.call` may reach it. */
  control: z.boolean(),
  /** Present only when `includeAgents` asked for it (#14160). */
  agents: AgentDirectorySchema.optional(),
});
export type HostListEntry = z.infer<typeof HostListEntrySchema>;

export const HostListResultSchema = z.object({ hosts: z.array(HostListEntrySchema) });
export type HostListResult = z.infer<typeof HostListResultSchema>;

/** A call names exactly one target: one of the host's projects, or a throwaway agent (#14444). */
function namesOneTarget(args: { projectId?: string; throwaway?: true }): boolean {
  return (args.projectId === undefined) !== (args.throwaway === undefined);
}

export const HostCallArgsSchema = z
  .object({
    hostId: hostIdSchema,
    projectId: idSchema
      .optional()
      .describe("A projectId from the host list. The call runs there. Never with throwaway."),
    throwaway: z
      .literal(true)
      .optional()
      .describe(
        "Instead of projectId: a short-lived agent this session owns, in a host folder. Tools: throwaway.launch, .status, .output, .sendCommand, .sendKeys, .close."
      ),
    tool: z
      .string()
      .min(1)
      .max(128)
      .describe("A Daintree tool on the host, by id. Search the host's own tools through this."),
    args: z.record(z.string(), z.unknown()).optional().describe("The tool's own arguments."),
    callId: idSchema
      .optional()
      .describe("Resend an ambiguous call under its callId. It never runs twice."),
    newCallId: idSchema
      .optional()
      .describe(
        "Your own fresh UUID for a write; with no answer back, resend under it as callId. Never both."
      ),
  })
  // A caller-chosen id names a first send, a callId a resend: one call is never both (#14240).
  .refine((args) => args.callId === undefined || args.newCallId === undefined)
  .refine(namesOneTarget)
  // A throwaway target takes only its own tools, with their own arguments.
  .refine(
    (args) =>
      args.throwaway === undefined ||
      HostThrowawayCallSchema.safeParse({ tool: args.tool, args: args.args ?? {} }).success
  );
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

/** What the person may agree to go past, by the question that asked. */
export const HOST_ENSURE_ACCEPTABLE = ["unpushed", "lfs_missing"] as const;
export type HostEnsureAcceptable = (typeof HOST_ENSURE_ACCEPTABLE)[number];

/** Answers `copy` takes besides a candidate's path: clone a fresh copy. */
export const HOST_ENSURE_NEW_COPY = "new";

export const HostEnsureProjectArgsSchema = z.object({
  hostId: hostIdSchema,
  worktree: z
    .boolean()
    .optional()
    .describe("Also make the branch's worktree there, at the remote's commit."),
  worktreePath: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Which of this project's worktrees has the branch. Default: the project folder."),
  copy: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('The person\'s answer to a copies question: a path it named, or "new" to clone.'),
  accept: z
    .array(z.enum(HOST_ENSURE_ACCEPTABLE))
    .max(HOST_ENSURE_ACCEPTABLE.length)
    .optional()
    .describe("Questions the person agreed to go past, up to 2."),
});
export type HostEnsureProjectArgs = z.infer<typeof HostEnsureProjectArgsSchema>;

export const HOST_ENSURE_QUESTIONS = [
  "unpushed",
  "branch_not_on_remote",
  "detached",
  "remote_unreachable",
  "lfs_missing",
  "no_remote",
  "multiple_copies",
  "committed_id_only",
  "destination_taken",
  "driven_elsewhere",
  "branch_not_placed",
] as const;
export type HostEnsureQuestionReason = (typeof HOST_ENSURE_QUESTIONS)[number];

const hostEnsureQuestionSchema = z.object({
  reason: z.enum(HOST_ENSURE_QUESTIONS),
  /** What to put to the person, in plain words. */
  detail: z.string(),
  /** Pass this in `accept` once the person agrees; null when only they can resolve it. */
  accept: z.enum(HOST_ENSURE_ACCEPTABLE).nullable(),
  /** The copies the person chooses between, by path for `copy`. */
  copies: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        registered: z.boolean(),
        matchedBy: z.enum(["remote-url", "committed-id"]),
      })
    )
    .nullable(),
});
export type HostEnsureQuestion = z.infer<typeof hostEnsureQuestionSchema>;

const hostEnsureReadySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  /** The branch's worktree on the host, when one was asked for and made or found. */
  worktreePath: z.string().nullable(),
  how: z.enum(["existing", "registered", "cloned"]),
  /** Changes on this machine that stayed here: nothing is pushed or sent. */
  leftHere: z.object({
    uncommittedChanges: z.number(),
    unpushedCommits: z.number().nullable(),
  }),
  /** Setup recipes the project carries. None was run. */
  setupRecipes: z.array(z.string()),
  /** What the host said about the branch, when it made no worktree. */
  note: z.string().nullable(),
});

/** Where an ensure stands, as the Shell's switch service answers it. */
export const HostEnsureAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), project: hostEnsureReadySchema }),
  z.object({ status: z.literal("question"), questions: z.array(hostEnsureQuestionSchema) }),
  /** Still cloning: call again with the same arguments, which joins it. */
  z.object({ status: z.literal("working") }),
  /** A git step failed on the host; `note` is git's own words there. */
  z.object({ status: z.literal("failed"), note: z.string() }),
]);
export type HostEnsureAnswer = z.infer<typeof HostEnsureAnswerSchema>;

export const HostEnsureProjectResultSchema = z.object({
  ...outcomeFields,
  hostId: z.string(),
  answer: HostEnsureAnswerSchema.nullable(),
});
export type HostEnsureProjectResult = z.infer<typeof HostEnsureProjectResultSchema>;

/** Most hosts one `host.settings` read or preview names. */
export const HOST_SETTINGS_HOSTS_MAX = 8;

export const HostSettingsArgsSchema = z.object({
  operation: z
    .enum(["read", "preview", "apply"])
    .describe(
      "read: current values. preview: what patch would change, and a ticket. apply: run it."
    ),
  hostIds: z
    .array(hostIdSchema)
    .min(1)
    .max(HOST_SETTINGS_HOSTS_MAX)
    .optional()
    .describe("For read and preview: the exact hosts, up to 8."),
  keys: z
    .array(z.enum(HOST_SETTING_KEYS))
    .max(HOST_SETTING_KEYS.length)
    .optional()
    .describe("For read: which settings, up to 5. Default: all."),
  patch: HostSettingsPatchFieldsSchema.optional().describe(
    "For preview: values to set on every host named."
  ),
  ticket: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("For apply: a preview's ticket. The person approves it in a dialog here first."),
});
export type HostSettingsArgs = z.infer<typeof HostSettingsArgsSchema>;

const settingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const HostSettingsResultSchema = z.object({
  ...outcomeFields,
  ticket: z.string().nullable(),
  hosts: z.array(
    z.object({
      hostId: z.string(),
      name: z.string(),
      outcome: outcomeSchema,
      detail: z.string().nullable(),
      settings: z.array(
        z.object({
          key: z.enum(HOST_SETTING_KEYS),
          value: settingValueSchema,
          proposed: settingValueSchema.optional(),
        })
      ),
    })
  ),
});
export type HostSettingsResult = z.infer<typeof HostSettingsResultSchema>;

/** Why a host tool refused outright: the caller isn't this machine's assistant, or its arguments don't parse. */
export type HostControlRefusalCode = "NOT_ELIGIBLE" | "INVALID_ARGS" | "UNAVAILABLE";

export type HostControlToolResult =
  HostListResult | HostCallResult | HostEnsureProjectResult | HostSettingsResult;

export type HostControlOutcome<T> =
  { ok: true; value: T } | { ok: false; code: HostControlRefusalCode; message: string };
