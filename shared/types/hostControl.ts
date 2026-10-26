import { z } from "zod";
import { AgentDirectorySchema } from "./agentDirectory.js";
import {
  ASSISTANT_HOST_SETTING_KEYS,
  AssistantHostSettingsPatchFieldsSchema,
} from "./hostSettings.js";
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

/**
 * One notice when a host's link or capacity is first observed meeting a
 * condition the caller named (#14463), so an assistant holding work for a host
 * can end its turn. Passive: it reads the link and summaries this Shell already
 * has, never dials, holds or wakes a host, and acts on nothing when it fires.
 */
export const HOST_WATCH_TOOL = "host.watch";

export const HOST_CONTROL_TOOL_IDS: ReadonlySet<string> = new Set([
  HOST_LIST_TOOL,
  HOST_CALL_TOOL,
  HOST_ENSURE_PROJECT_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
]);

/** Most projects `host.list` names for one host in one answer: a page. */
export const HOST_LIST_PROJECTS_MAX = 50;
/**
 * Most bytes the project pages of one `host.list` answer take across every
 * host; a page that would go over is cut short, and its cursor goes on from there.
 */
export const HOST_LIST_PROJECT_BYTES_MAX = 32 * 1024;
/** Longest project name a page carries, so one project always fits a page. */
export const HOST_LIST_PROJECT_NAME_MAX = 256;
export const HOST_LIST_PROJECT_QUERY_MAX = 128;
export const HOST_LIST_PROJECT_CURSOR_MAX = 1024;

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
  hostId: hostIdSchema.optional().describe("List only this host."),
  projectQuery: z
    .string()
    .min(1)
    .max(HOST_LIST_PROJECT_QUERY_MAX)
    .optional()
    .describe("Only projects whose name contains this, any case."),
  projectCursor: z
    .string()
    .min(1)
    .max(HOST_LIST_PROJECT_CURSOR_MAX)
    .optional()
    .describe("A projectInventory.nextCursor: that host's next page, same query."),
});
export type HostListArgs = z.infer<typeof HostListArgsSchema>;

/** Most installed CLIs `host.list` names for one host; the rest are counted in `omitted`. */
export const HOST_LIST_CLIS_MAX = 32;

const HostListHandshakeSchema = z.object({
  version: z.string(),
  commit: z.string(),
  protocolVersion: z.number(),
  platform: z.enum(["darwin", "linux"]),
  arch: z.enum(["x64", "arm64"]),
});

/** The link as this Shell observed it: flags it saw, never a cause it guessed. */
export const HostListLinkSchema = z.object({
  status: z.enum([
    "local",
    "disconnected",
    "connecting",
    "connected",
    "unreachable",
    "version-mismatch",
    "driven-elsewhere",
  ]),
  attempt: z.number().nullable(),
  restarting: z.boolean().describe("It said it was shutting down; still retried."),
  hostModeOff: z.boolean().describe("ssh got in; no Daintree in Host mode there."),
  stoppedRetrying: z
    .boolean()
    .nullable()
    .describe("Waits for a Connect: login refused, Host mode off or unusable."),
  disconnectedByPerson: z.boolean(),
  quietSince: z.number().nullable().describe("Connected; silent since."),
  mismatch: z
    .object({
      kind: z.enum(["protocol", "version", "commit"]),
      local: z.string(),
      remote: z.string(),
    })
    .nullable()
    .describe("Builds differ; blocking only under version-mismatch."),
});
export type HostListLink = z.infer<typeof HostListLinkSchema>;

export const HostListBuildSchema = z.object({
  source: z.enum(["connected", "rejected", "last-seen", "unknown"]),
  handshake: HostListHandshakeSchema.nullable(),
});
export type HostListBuild = z.infer<typeof HostListBuildSchema>;

export const HostListAgentClisSchema = z
  .object({
    coverage: z.enum(["observed", "stale", "unknown"]),
    sampledAt: z.number().nullable(),
    installed: z
      .array(z.object({ agentId: z.string(), version: z.string().nullable() }))
      .max(HOST_LIST_CLIS_MAX),
    omitted: z.number(),
  })
  .describe("Installed only: sign-in and quota unknown. Absence unproven.");
export type HostListAgentClis = z.infer<typeof HostListAgentClisSchema>;

export const HostListEntrySchema = z.object({
  hostId: z.string(),
  name: z.string(),
  connection: z.enum(["connected", "connecting", "disconnected"]),
  link: HostListLinkSchema,
  build: HostListBuildSchema,
  agentClis: HostListAgentClisSchema,
  rttMs: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  load: z
    .object({
      sampledAt: z.number(),
      receivedAt: z.number().nullable(),
      ageMs: z.number().nullable().describe("At most this old. Null: unknown."),
      stale: z
        .boolean()
        .describe("Too old to trust: the live figures below are null. Not a zero reading."),
      staleReason: z
        .enum(["age-limit", "clock-uncertain"])
        .nullable()
        .describe("clock-uncertain: no age bound, and its timestamp is off this clock."),
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
  /** How much of the host's project list `projects` is; null exactly when `projects` is. */
  projectInventory: z
    .object({
      complete: z
        .boolean()
        .describe(
          "This answer names every match. With a total, pages walked to a null nextCursor name them all."
        ),
      total: z.number().nullable().describe("Null: past the host's own list limit."),
      offset: z.number(),
      omitted: z
        .number()
        .nullable()
        .describe("Matching projects not named here, earlier pages too."),
      nextCursor: z.string().nullable().describe("projectCursor for the next page."),
      listChanged: z.boolean().describe("The list changed since the cursor: its first page again."),
    })
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
    projectId: idSchema.optional().describe("A projectId from the host list. The call runs there."),
    throwaway: z
      .literal(true)
      .optional()
      .describe(
        "Instead of projectId: a short-lived agent this session owns, in a host folder. Tools: throwaway.launch, status, output, sendCommand, sendKeys, close."
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
    .array(z.enum(ASSISTANT_HOST_SETTING_KEYS))
    .max(ASSISTANT_HOST_SETTING_KEYS.length)
    .optional()
    .describe(
      `For read: which settings, up to ${ASSISTANT_HOST_SETTING_KEYS.length}. Default: all.`
    ),
  patch: AssistantHostSettingsPatchFieldsSchema.optional().describe(
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
          key: z.enum(ASSISTANT_HOST_SETTING_KEYS),
          value: settingValueSchema,
          proposed: settingValueSchema.optional(),
        })
      ),
    })
  ),
});
export type HostSettingsResult = z.infer<typeof HostSettingsResultSchema>;

/** How long a watch stays armed when the caller doesn't say. */
export const HOST_WATCH_EXPIRES_DEFAULT_S = 30 * 60;
export const HOST_WATCH_EXPIRES_MIN_S = 60;
export const HOST_WATCH_EXPIRES_MAX_S = 6 * 60 * 60;
/** Watches one assistant run may hold at once: armed, or fired with the notice not yet settled. */
export const HOST_WATCHES_PER_RUN_MAX = 8;
/** Watches armed across every assistant on this Shell. */
export const HOST_WATCHES_TOTAL_MAX = 64;
/** Ended watches a run's `list` still shows, newest first. */
export const HOST_WATCH_HISTORY_MAX = 16;
/** How long a link must stay in the watched state before the watch fires, so a flap doesn't. */
export const HOST_WATCH_CONNECTION_SETTLE_MS = 5_000;
/** Longest note a watch echoes back. */
export const HOST_WATCH_NOTE_MAX = 160;

export const HostWatchArgsSchema = z.object({
  operation: z
    .enum(["arm", "cancel", "list"])
    .describe(
      "arm: one notice when first observed. cancel: end one. list: yours, armed and ended."
    ),
  hostId: hostIdSchema.optional().describe("For arm: the host. For list: only that host."),
  connection: z
    .enum(["connected", "disconnected"])
    .optional()
    .describe("Arm on the link: fires once it is seen in this state for 5s."),
  memoryAvailableBytesAtLeast: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Arm on capacity instead: all given figures met by a fresh sample."),
  cpuIdleCoresAtLeast: z.number().min(0).max(4096).optional(),
  memoryPressureAtMost: z.enum(["normal", "warn"]).optional(),
  expiresInSeconds: z
    .number()
    .int()
    .min(HOST_WATCH_EXPIRES_MIN_S)
    .max(HOST_WATCH_EXPIRES_MAX_S)
    .optional()
    .describe("Default 1800."),
  note: z.string().max(HOST_WATCH_NOTE_MAX).optional().describe("Echoed in the notice."),
  watchId: z.string().min(1).max(64).optional().describe("For cancel."),
});
export type HostWatchArgs = z.infer<typeof HostWatchArgsSchema>;

const hostWatchConditionSchema = z.object({
  connection: z.enum(["connected", "disconnected"]).nullable(),
  memoryAvailableBytesAtLeast: z.number().nullable(),
  cpuIdleCoresAtLeast: z.number().nullable(),
  memoryPressureAtMost: z.enum(["normal", "warn"]).nullable(),
});
export type HostWatchCondition = z.infer<typeof hostWatchConditionSchema>;

/** A host as this Shell saw it at one moment: observations, never a promise it can take work. */
export const HostWatchObservedSchema = z.object({
  /** When this Shell read it, by its own clock. */
  observedAt: z.number(),
  link: HostListLinkSchema.shape.status,
  lastSeenAt: z.number().nullable(),
  /** The last sample's time, by the host's clock; null when none is held. */
  sampledAt: z.number().nullable(),
  /** Too old to trust: the figures below are null. */
  stale: z.boolean(),
  memoryAvailableBytes: z.number().nullable(),
  cpuIdleCores: z.number().nullable(),
  memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
});
export type HostWatchObserved = z.infer<typeof HostWatchObservedSchema>;

export const HOST_WATCH_STATUSES = ["armed", "fired", "expired", "cancelled", "lost"] as const;
export type HostWatchStatus = (typeof HOST_WATCH_STATUSES)[number];
export const HOST_WATCH_LOST_REASONS = ["host-removed", "control-off"] as const;
export type HostWatchLostReason = (typeof HOST_WATCH_LOST_REASONS)[number];
/**
 * Where the notice a watch ended with stands. `none`: it ended with no notice
 * (armed, or cancelled). `withdrawn`: cancelled before it was typed.
 * `ambiguous` is never typed again.
 */
export const HOST_WATCH_DELIVERIES = [
  "none",
  "queued",
  "held",
  "delivered",
  "unavailable",
  "ambiguous",
  "withdrawn",
] as const;
export type HostWatchDelivery = (typeof HOST_WATCH_DELIVERIES)[number];

export const HostWatchSchema = z.object({
  watchId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  condition: hostWatchConditionSchema,
  note: z.string().nullable(),
  armedAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(HOST_WATCH_STATUSES),
  endedAt: z.number().nullable(),
  lostReason: z.enum(HOST_WATCH_LOST_REASONS).nullable(),
  /** What it fired, expired or was lost on; null while armed or once cancelled. */
  observed: HostWatchObservedSchema.nullable(),
  delivery: z.enum(HOST_WATCH_DELIVERIES),
});
export type HostWatch = z.infer<typeof HostWatchSchema>;

export const HostWatchResultSchema = z.object({
  ...outcomeFields,
  /** An arm left a watch armed. False with `ok`: already observed, so none was armed. */
  armed: z.boolean(),
  /** The watch armed or cancelled; for list, this run's, armed first, then ended newest first. */
  watches: z.array(HostWatchSchema),
  /** arm: the host as observed when it was asked. */
  observed: HostWatchObservedSchema.nullable(),
});
export type HostWatchResult = z.infer<typeof HostWatchResultSchema>;

/** Why a host tool refused outright: the caller isn't this machine's assistant, or its arguments don't parse. */
export type HostControlRefusalCode = "NOT_ELIGIBLE" | "INVALID_ARGS" | "UNAVAILABLE";

export type HostControlToolResult =
  HostListResult | HostCallResult | HostEnsureProjectResult | HostSettingsResult | HostWatchResult;

export type HostControlOutcome<T> =
  { ok: true; value: T } | { ok: false; code: HostControlRefusalCode; message: string };
