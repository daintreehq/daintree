import { z } from "zod";
import { parseCron, validateTimeZone } from "../utils/cron.js";
import { occurrenceKeyFor, outcomeForEvidence } from "../utils/scheduledRuns.js";

// The contract for scheduled agent runs (#15973). docs/architecture/scheduled-runs.md
// says which child writes each part; records are complete on disk, and defaults
// are applied only when a schedule is created (`createSchedule`).

const IdSchema = z.string().min(1);
const EpochMsSchema = z.number().int().nonnegative();
const ExitCodeSchema = z.number().int().nullable();

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
  }),
});

export const ScheduleLaunchSchema = z.strictObject({
  agentId: IdSchema,
  /** Null launches with no preset, as `agent.launch` reads an explicit null. */
  presetId: IdSchema.nullable(),
  prompt: nonblank("Enter a prompt for the agent"),
  /** Null is the project's main checkout, never whichever worktree is active. */
  worktreeId: IdSchema.nullable(),
});

export const SchedulePreconditionSchema = z.strictObject({
  /** Run in a shell in the launch worktree; the run goes ahead only on exit 0. */
  command: nonblank("Enter a command, or turn the check off"),
});

export const SchedulePoliciesSchema = z.strictObject({
  missedRuns: z.enum(SCHEDULE_MISSED_RUN_POLICIES),
  overlap: z.enum(SCHEDULE_OVERLAP_POLICIES),
  precondition: SchedulePreconditionSchema.nullable(),
  onDone: z.enum(SCHEDULE_DONE_POLICIES),
  runWhenClosed: z.boolean(),
});

export const ScheduleSchema = z.strictObject({
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
});

export type ScheduleMissedRunPolicy = (typeof SCHEDULE_MISSED_RUN_POLICIES)[number];
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];
export type ScheduleDonePolicy = (typeof SCHEDULE_DONE_POLICIES)[number];
export type ScheduleCadence = z.infer<typeof ScheduleCadenceSchema>;
export type ScheduleLaunch = z.infer<typeof ScheduleLaunchSchema>;
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
    signal: ExitCodeSchema,
    error: z.string().nullable(),
  }),
]);

/** The fact a run settled on. Agent state heuristics are never evidence. */
export const ScheduledRunEvidenceSchema = z.discriminatedUnion("kind", [
  /** A marker the agent printed. */
  z.strictObject({ kind: z.literal("handback"), report: z.enum(["done", "needs-you"]) }),
  z.strictObject({
    kind: z.literal("exit"),
    process: z.enum(["agent", "pty"]),
    exitCode: ExitCodeSchema,
    signal: ExitCodeSchema,
  }),
  z.strictObject({ kind: z.literal("skip"), reason: ScheduledRunSkipReasonSchema }),
  z.strictObject({ kind: z.literal("launch-error"), message: z.string() }),
  /** The user stopped the run. */
  z.strictObject({ kind: z.literal("cancel") }),
  /** The overlap policy is `replace` and `replacedByRunId` took this run's place. */
  z.strictObject({ kind: z.literal("replace"), replacedByRunId: IdSchema }),
  /** The PTY host confirmed the run's terminal is gone, with no exit seen (a crash). */
  z.strictObject({ kind: z.literal("lost") }),
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
    signal: ExitCodeSchema,
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

export const ScheduledRunSchema = z
  .strictObject({
    id: IdSchema,
    scheduleId: IdSchema,
    projectId: IdSchema,
    origin: ScheduledRunOriginSchema,
    /** When the run was registered, which is before anything spawns. */
    createdAt: EpochMsSchema,
    /** Reserved at registration so the launch and the record agree on it. */
    terminalId: IdSchema.nullable(),
    settlement: ScheduledRunSettlementSchema,
    process: z.strictObject({
      /** The agent CLI, which can exit and leave its shell running. */
      agent: ScheduledRunProcessSchema,
      pty: ScheduledRunProcessSchema,
    }),
    pane: ScheduledRunPaneSchema,
    resume: ScheduledRunResumeSchema.nullable(),
  })
  .superRefine((run, ctx) => {
    const { origin, settlement } = run;
    if (origin.dueAt !== null && origin.occurrenceKey !== occurrenceKeyFor(origin.dueAt)) {
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
        const launched =
          run.terminalId !== null ||
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
export type ScheduledRun = z.infer<typeof ScheduledRunSchema>;
