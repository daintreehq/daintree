import { z } from "zod";
import { HANDBACK_MESSAGE_MAX_CHARS } from "./handback.js";
import { parseCron, validateTimeZone } from "../utils/cron.js";
import {
  isScheduleAssistantAgentId,
  occurrenceKeyFor,
  outcomeForEvidence,
  SCHEDULED_RUN_WORKERS_MAX,
} from "../utils/scheduledRuns.js";

// The contract for scheduled agent runs (#15973). docs/architecture/scheduled-runs.md
// says which child writes each part; records are complete on disk, and defaults
// are applied only when a schedule is created (`createSchedule`).

// The latest instant `Date` can represent.
const MAX_EPOCH_MS = 8_640_000_000_000_000;

const IdSchema = z.string().min(1);
const EpochMsSchema = z.number().int().nonnegative().max(MAX_EPOCH_MS);
const ExitCodeSchema = z.number().int().nullable();
/** Null when no signal ended the process; producers map node-pty's 0 to null. */
const SignalSchema = z.number().int().positive().nullable();

function nonblank(message: string) {
  return z.string().refine((value) => value.trim() !== "", { message });
}

export const SCHEDULE_MISSED_RUN_POLICIES = ["run-once-late", "skip"] as const;
export const SCHEDULE_OVERLAP_POLICIES = ["skip", "start-another", "replace"] as const;
export const SCHEDULE_DONE_POLICIES = ["keep", "background", "close"] as const;

export const ScheduleCadenceSchema = z.strictObject({
  cron: z.string().superRefine((value, ctx) => {
    const result = parseCron(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.error.message });
  }),
  timeZone: z.string().superRefine((value, ctx) => {
    const result = validateTimeZone(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: result.message });
    else if (value !== value.trim()) {
      ctx.addIssue({ code: "custom", message: "Remove the spaces around the time zone" });
    }
  }),
});

/** Each run starts in a new worktree on a new branch from this base (#16369). */
export const ScheduleNewWorktreeSchema = z.strictObject({
  baseBranch: nonblank("Choose a base branch"),
  /** The base is a remote branch (`origin/develop`), as the worktree create reads it. */
  fromRemote: z.boolean(),
});

export const ScheduleLaunchSchema = z.strictObject({
  agentId: IdSchema,
  /** Null launches with no preset, as `agent.launch` reads an explicit null. */
  presetId: IdSchema.nullable(),
  prompt: nonblank("Enter a prompt for the agent"),
  /**
   * Null is the project's main checkout, never whichever worktree is active,
   * unless `newWorktree` gives each run its own.
   */
  worktreeId: IdSchema.nullable(),
  /** Null launches in `worktreeId`. Set, `worktreeId` is null. */
  newWorktree: ScheduleNewWorktreeSchema.nullable(),
});

export const SchedulePreconditionSchema = z.strictObject({
  /**
   * Run in a shell in the launch worktree, or in the project's folder for a
   * schedule with no worktree yet (`newWorktree`); the run goes ahead only on exit 0.
   */
  command: nonblank("Enter a command, or turn the check off"),
});

export const SchedulePoliciesSchema = z.strictObject({
  missedRuns: z.enum(SCHEDULE_MISSED_RUN_POLICIES),
  overlap: z.enum(SCHEDULE_OVERLAP_POLICIES),
  precondition: SchedulePreconditionSchema.nullable(),
  onDone: z.enum(SCHEDULE_DONE_POLICIES),
  runWhenClosed: z.boolean(),
});

export const ScheduleSchema = z
  .strictObject({
    id: IdSchema,
    projectId: IdSchema,
    name: z
      .string()
      .max(200)
      .refine((value) => value.trim() !== "", { message: "Name the schedule" }),
    enabled: z.boolean(),
    cadence: ScheduleCadenceSchema,
    launch: ScheduleLaunchSchema,
    policies: SchedulePoliciesSchema,
    createdAt: EpochMsSchema,
    updatedAt: EpochMsSchema,
  })
  .superRefine((schedule, ctx) => {
    if (schedule.launch?.newWorktree && schedule.launch.worktreeId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["launch", "newWorktree"],
        message: "A run starts in a chosen worktree or a new one, not both",
      });
    }
    // The Assistant (#16169) starts in its own session folder with its own
    // settings, in a tab of its own: no preset, no worktree, no grid to leave.
    if (!isScheduleAssistantAgentId(schedule.launch?.agentId)) return;
    if (schedule.launch.presetId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["launch", "presetId"],
        message: "The Daintree Assistant runs with its own settings, not a preset",
      });
    }
    if (schedule.launch.worktreeId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["launch", "worktreeId"],
        message: "The Daintree Assistant works across the project; name a worktree in the prompt",
      });
    }
    if (schedule.launch.newWorktree) {
      ctx.addIssue({
        code: "custom",
        path: ["launch", "newWorktree"],
        message: "The Daintree Assistant works across the project; name a worktree in the prompt",
      });
    }
    if (schedule.policies?.onDone === "background") {
      ctx.addIssue({
        code: "custom",
        path: ["policies", "onDone"],
        message: "The Daintree Assistant runs in its own tab, so keep it or close it",
      });
    }
  });

/**
 * A project's own say over its schedules (#16166), kept on this machine beside
 * them. `schedulesOn` decides whether any of them fires; `startWhenClosed`
 * whether the OS job starts Daintree for them, and counts only while
 * `schedulesOn` holds. Each is kept as set while the other changes.
 */
export const ProjectScheduleSwitchesSchema = z.strictObject({
  schedulesOn: z.boolean(),
  startWhenClosed: z.boolean(),
  /**
   * When `schedulesOn` was last turned on. Nothing due before it counts as
   * missed, across a restart too. Null for a project whose schedules were on
   * before the switches existed.
   */
  schedulesOnSince: EpochMsSchema.nullable(),
});

export type ProjectScheduleSwitches = z.infer<typeof ProjectScheduleSwitchesSchema>;

/** A project that has never turned its schedules on. */
export const SCHEDULE_SWITCHES_OFF: ProjectScheduleSwitches = Object.freeze({
  schedulesOn: false,
  startWhenClosed: false,
  schedulesOnSince: null,
});

export type ScheduleMissedRunPolicy = (typeof SCHEDULE_MISSED_RUN_POLICIES)[number];
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];
export type ScheduleDonePolicy = (typeof SCHEDULE_DONE_POLICIES)[number];
export type ScheduleCadence = z.infer<typeof ScheduleCadenceSchema>;
export type ScheduleLaunch = z.infer<typeof ScheduleLaunchSchema>;
export type ScheduleNewWorktree = z.infer<typeof ScheduleNewWorktreeSchema>;
export type SchedulePrecondition = z.infer<typeof SchedulePreconditionSchema>;
export type SchedulePolicies = z.infer<typeof SchedulePoliciesSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;

/** The occurrences a late run stands for: every one due in `(after, through]`. */
export const CoalescedOccurrencesSchema = z.strictObject({
  after: EpochMsSchema,
  through: EpochMsSchema,
});

const OccurrenceFields = {
  dueAt: EpochMsSchema,
  /** `occurrenceKeyFor(dueAt)`; unique per schedule, so an occurrence runs once. */
  occurrenceKey: z.string().min(1),
};

export const ScheduledRunOriginSchema = z.discriminatedUnion("trigger", [
  z.strictObject({
    trigger: z.literal("scheduled"),
    ...OccurrenceFields,
    coalesced: z.null(),
  }),
  z.strictObject({
    trigger: z.literal("catch-up"),
    ...OccurrenceFields,
    coalesced: CoalescedOccurrencesSchema,
  }),
  z.strictObject({
    trigger: z.literal("os-launch"),
    ...OccurrenceFields,
    coalesced: CoalescedOccurrencesSchema.nullable(),
  }),
  z.strictObject({
    trigger: z.literal("run-now"),
    dueAt: z.null(),
    occurrenceKey: z.null(),
    coalesced: z.null(),
  }),
]);

export const ScheduledRunSkipReasonSchema = z.discriminatedUnion("kind", [
  /** The missed-runs policy is `skip`. */
  z.strictObject({ kind: z.literal("missed") }),
  /** The overlap policy is `skip` and `openRunId` hadn't settled. */
  z.strictObject({ kind: z.literal("overlap"), openRunId: IdSchema }),
  /** The precondition exited non-zero, was killed, or couldn't run (`error`). */
  z.strictObject({
    kind: z.literal("precondition"),
    exitCode: ExitCodeSchema,
    signal: SignalSchema,
    error: z.string().nullable(),
  }),
  /**
   * The schedule's agent is the Daintree Assistant (#16169) and every one of
   * the project's Assistant sessions was taken: none is ever displaced for it.
   */
  z.strictObject({ kind: z.literal("assistant-sessions-full") }),
]);

/** The fact a run settled on. Agent state heuristics are never evidence. */
export const ScheduledRunEvidenceSchema = z.discriminatedUnion("kind", [
  /**
   * A marker the agent printed for the run's launch prompt, with its one-line
   * summary as captured (null for none): the agent's own claim, never checked.
   */
  z.strictObject({
    kind: z.literal("handback"),
    report: z.enum(["done", "needs-you"]),
    summary: z.string().min(1).max(HANDBACK_MESSAGE_MAX_CHARS).nullable(),
    /** The summary was cut at the capture's cap. */
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("exit"),
    process: z.enum(["agent", "pty"]),
    exitCode: ExitCodeSchema,
    signal: SignalSchema,
  }),
  z.strictObject({ kind: z.literal("skip"), reason: ScheduledRunSkipReasonSchema }),
  z.strictObject({ kind: z.literal("launch-error"), message: z.string() }),
  /** The user stopped the run. */
  z.strictObject({ kind: z.literal("cancel") }),
  /** The overlap policy is `replace` and `replacedByRunId` took this run's place. */
  z.strictObject({ kind: z.literal("replace"), replacedByRunId: IdSchema }),
  /** The PTY host confirmed the run's terminal is gone, with no exit seen (a crash). */
  z.strictObject({ kind: z.literal("lost") }),
  /**
   * Daintree quit or crashed while the run was open; settled at the next
   * startup. A quit's own terminal kills are never read as the run's exit.
   */
  z.strictObject({ kind: z.literal("interrupted") }),
]);

export const SCHEDULED_RUN_OUTCOMES = [
  "done",
  "needs-you",
  "failed",
  "exited",
  "skipped",
  "cancelled",
  "replaced",
  "lost",
  "interrupted",
] as const;

/**
 * Whether the run is over as far as its schedule is concerned. Overlap reads
 * this, not the process or pane: a kept terminal or a conversation the user
 * carries on doesn't hold the next run back.
 */
export const ScheduledRunSettlementSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("open") }),
  z.strictObject({
    state: z.literal("settled"),
    settledAt: EpochMsSchema,
    outcome: z.enum(SCHEDULED_RUN_OUTCOMES),
    evidence: ScheduledRunEvidenceSchema,
  }),
]);

/** What was observed of one process. `not-started` means no start was seen. */
export const ScheduledRunProcessSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not-started") }),
  z.strictObject({ state: z.literal("running"), startedAt: EpochMsSchema }),
  z.strictObject({
    state: z.literal("exited"),
    startedAt: EpochMsSchema.nullable(),
    exitedAt: EpochMsSchema,
    exitCode: ExitCodeSchema,
    signal: SignalSchema,
  }),
]);

export const ScheduledRunPaneSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("open"), since: EpochMsSchema }),
  /** Moved to the background by the done policy or the user, not just out of view. */
  z.strictObject({ state: z.literal("background"), since: EpochMsSchema }),
  z.strictObject({ state: z.literal("closed"), closedAt: EpochMsSchema }),
]);

/** What a closed run's terminal needs to resume like any historic agent chat. */
export const ScheduledRunResumeSchema = z.strictObject({
  agentId: IdSchema,
  /** Null until captured; capture can land after settlement. */
  agentSessionId: IdSchema.nullable(),
  cwd: z.string().min(1),
  worktreeId: IdSchema.nullable(),
  agentLaunchFlags: z.array(z.string()),
  agentModelId: IdSchema.nullable(),
  agentPresetId: IdSchema.nullable(),
});

/**
 * The worktree a run of a new-worktree schedule was given (#16369). What ran in
 * it is `resume`, which a refused run doesn't have; this says what was made.
 */
export const ScheduledRunNewWorktreeSchema = z.strictObject({
  /** The branch generated for the run. */
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  /** Null when no worktree was confirmed: creating it failed or went unanswered. */
  worktreeId: IdSchema.nullable(),
});

/**
 * A worker an Assistant run launched (#16169), as its launch was answered:
 * a terminal the answer named, never one inferred from what runs.
 */
export const ScheduledRunWorkerSchema = z.strictObject({
  terminalId: IdSchema,
  /** The paired host it landed on; null for this machine. */
  hostId: IdSchema.nullable(),
  /** The host's name when the launch was seen; null for this machine or one unnamed then. */
  hostName: z.string().min(1).nullable(),
  projectId: IdSchema,
  /** The project's name when the launch was seen, if known then. */
  projectName: z.string().min(1).nullable(),
  /** The agent the launch asked for, when it named one. */
  agentId: IdSchema.nullable(),
  observedAt: EpochMsSchema,
});

export const ScheduledRunSchema = z
  .strictObject({
    id: IdSchema,
    scheduleId: IdSchema,
    projectId: IdSchema,
    origin: ScheduledRunOriginSchema,
    /** When the run was registered, which is before anything spawns. */
    createdAt: EpochMsSchema,
    /**
     * Reserved before the launch so the launch and the record agree on it. A
     * run skipped before one was reserved keeps null.
     */
    terminalId: IdSchema.nullable(),
    /**
     * The spawn incarnation of `terminalId` the run was matched to, the PTY
     * host's `spawnedAt`; null until the terminal first spawns. A restart under
     * the same id is a different incarnation, so its facts aren't this run's.
     */
    terminalSpawnedAt: EpochMsSchema.nullable(),
    settlement: ScheduledRunSettlementSchema,
    process: z.strictObject({
      /** The agent CLI, which can exit and leave its shell running. */
      agent: ScheduledRunProcessSchema,
      pty: ScheduledRunProcessSchema,
    }),
    pane: ScheduledRunPaneSchema,
    resume: ScheduledRunResumeSchema.nullable(),
    /** The worktree made for the run (#16369); absent for a run of any other schedule. */
    newWorktree: ScheduledRunNewWorktreeSchema.optional(),
    /** The run launched the project's Daintree Assistant (#16169); absent for an agent's run. */
    assistant: z.literal(true).optional(),
    /** An Assistant run's workers, as each launch was seen; only on an Assistant's run. */
    workers: z.array(ScheduledRunWorkerSchema).max(SCHEDULED_RUN_WORKERS_MAX).optional(),
  })
  .superRefine((run, ctx) => {
    const { origin, settlement } = run;
    if (run.workers !== undefined && run.assistant !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["workers"],
        message: "Only an Assistant's run lists workers",
      });
    }
    // A failed number check doesn't stop this refinement, and `toISOString`
    // throws outside Date's range.
    const { dueAt } = origin;
    if (
      dueAt !== null &&
      Number.isInteger(dueAt) &&
      Math.abs(dueAt) <= MAX_EPOCH_MS &&
      origin.occurrenceKey !== occurrenceKeyFor(dueAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["origin", "occurrenceKey"],
        message: "occurrenceKey must be occurrenceKeyFor(dueAt)",
      });
    }
    if (
      origin.coalesced !== null &&
      !(origin.coalesced.after < origin.dueAt && origin.dueAt <= origin.coalesced.through)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["origin", "coalesced"],
        message: "dueAt must fall in (after, through]",
      });
    }
    if (settlement.state === "settled") {
      if (settlement.outcome !== outcomeForEvidence(settlement.evidence)) {
        ctx.addIssue({
          code: "custom",
          path: ["settlement", "outcome"],
          message: "outcome must follow from the evidence",
        });
      }
      const { evidence } = settlement;
      if (evidence.kind === "skip") {
        // A reserved terminal id alone isn't a launch: registration can reserve
        // one before the precondition runs.
        const launched =
          run.pane.state !== "none" ||
          run.process.agent.state !== "not-started" ||
          run.process.pty.state !== "not-started";
        if (launched) {
          ctx.addIssue({
            code: "custom",
            path: ["settlement", "evidence"],
            message: "a skipped run never launches",
          });
        }
        if (run.resume !== null) {
          ctx.addIssue({
            code: "custom",
            path: ["resume"],
            message: "a skipped run has nothing to resume",
          });
        }
        const { reason } = evidence;
        if (reason.kind === "missed" && origin.dueAt === null) {
          ctx.addIssue({
            code: "custom",
            path: ["settlement", "evidence", "reason"],
            message: "only an occurrence can be missed",
          });
        }
        if (
          reason.kind === "precondition" &&
          reason.exitCode === 0 &&
          reason.signal === null &&
          reason.error === null
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["settlement", "evidence", "reason"],
            message: "a precondition that exited 0 passed",
          });
        }
      }
    }
    if (run.terminalSpawnedAt !== null && run.terminalId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["terminalSpawnedAt"],
        message: "an incarnation needs its terminal id",
      });
    }
    if (run.pane.state !== "none" && run.terminalId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["terminalId"],
        message: "a pane needs its terminal id",
      });
    }
  });

export type ScheduledRunOutcome = (typeof SCHEDULED_RUN_OUTCOMES)[number];
export type CoalescedOccurrences = z.infer<typeof CoalescedOccurrencesSchema>;
export type ScheduledRunOrigin = z.infer<typeof ScheduledRunOriginSchema>;
export type ScheduledRunTrigger = ScheduledRunOrigin["trigger"];
export type ScheduledRunSkipReason = z.infer<typeof ScheduledRunSkipReasonSchema>;
export type ScheduledRunEvidence = z.infer<typeof ScheduledRunEvidenceSchema>;
export type ScheduledRunSettlement = z.infer<typeof ScheduledRunSettlementSchema>;
export type ScheduledRunProcess = z.infer<typeof ScheduledRunProcessSchema>;
export type ScheduledRunPane = z.infer<typeof ScheduledRunPaneSchema>;
export type ScheduledRunResume = z.infer<typeof ScheduledRunResumeSchema>;
export type ScheduledRunNewWorktree = z.infer<typeof ScheduledRunNewWorktreeSchema>;
export type ScheduledRun = z.infer<typeof ScheduledRunSchema>;
export type ScheduledRunWorker = z.infer<typeof ScheduledRunWorkerSchema>;
