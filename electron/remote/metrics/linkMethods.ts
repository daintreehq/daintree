import { z } from "zod";
import { FLEET_BANDS } from "../../../shared/utils/fleetBands.js";
import { DriverObservationSchema } from "../link/schemas.js";

/** Bounds on what one host answers, so a busy host can't flood a Shell. */
export const MAX_FLEET_TARGETS = 500;
export const MAX_HOST_WORKTREES = 2000;
/** One worktree's agents: more than any pane grid holds. */
export const MAX_WORKTREE_RUNS = 64;
export const MAX_FLEET_SUBMIT_CHARS = 1024 * 1024;

/**
 * Session-level methods behind the hosts overview and the fleet features.
 * They ride every session, including a summary-only one with no view bound,
 * so a Shell can reach a host it isn't showing.
 */
export const MetricsLinkMethod = {
  /** Host → Shell: an agent on the host needs someone. The host decided; the Shell presents. */
  ATTENTION: "host.attention",
  /** Shell → Host: the host's agent runs, as fleet targets. */
  LIST_FLEET_TARGETS: "fleet.list-targets",
  /** Shell → Host: submit a fleet prompt to one of the host's agents. */
  SUBMIT_FLEET: "fleet.submit",
  /** Shell → Host: every worktree of the host's open projects. */
  LIST_WORKTREES: "host.list-worktrees",
  /**
   * Host → Shell: what `LIST_WORKTREES` would answer has changed. Carries
   * nothing; a Shell showing this host's worktrees asks again. A Shell from
   * before it existed refuses the call, which the host ignores.
   */
  WORKTREES_CHANGED: "host.worktrees-changed",
  /**
   * Shell → Host: what restarting the host would end (terminals by project,
   * running operations, other attached Shells). A host from before it existed
   * answers UNSUPPORTED, and the Shell falls back to the summary's counts.
   */
  RESTART_IMPACT: "host.restart-impact",
  /**
   * Shell → Host: what the host saw happen to its links lately, who drives
   * each project, and which Shells are attached. A host from before it existed
   * answers UNSUPPORTED, and the Shell says that host can't report it.
   */
  LINK_ACTIVITY: "host.link-activity",
} as const;

const id = z.string().min(1).max(256);
const name = z.string().max(1024);

export const AttentionPayloadSchema = z.object({
  kind: z.literal("waiting"),
  terminalId: id,
  projectName: name.nullable(),
  agentName: name.nullable(),
  /** The host's own quiet hours hold this back: the Shell files it in the inbox without a toast. */
  quiet: z.boolean(),
});
export type AttentionPayload = z.infer<typeof AttentionPayloadSchema>;

const FLEET_OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A Shell-minted fleet opId, or null when absent or malformed. */
export function normalizeFleetOpId(value: unknown): string | null {
  return typeof value === "string" && FLEET_OP_ID_PATTERN.test(value) ? value : null;
}

export const SubmitFleetPayloadSchema = z.object({
  terminalId: id,
  text: z.string().min(1).max(MAX_FLEET_SUBMIT_CHARS),
  /** The Shell's id for this one submit: a resend with it never types the prompt twice. */
  opId: z.string().regex(FLEET_OP_ID_PATTERN).nullish(),
});

const agentState = z.enum(["idle", "working", "waiting", "directing", "completed", "exited"]);

export const FleetTargetListSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            terminalId: id,
            title: name,
            projectId: id.nullable(),
            projectName: name.nullable(),
            agentId: id.nullable(),
            agentState: agentState.nullable(),
          })
          .strip()
      )
      .max(MAX_FLEET_TARGETS),
    complete: z.boolean(),
  })
  .strip();

const hostPath = z.string().min(1).max(4096);

export const WorktreeListSchema = z
  .array(
    z
      .object({
        projectId: id,
        projectName: name,
        worktreeId: z.string().min(1).max(4096),
        name,
        branch: name.nullable(),
        path: hostPath,
        isMainWorktree: z.boolean(),
        modifiedCount: z.number().int().min(0).nullable(),
        lastActivityAt: z.number().finite().nullable(),
        // Absent from a host from before it was sent: no observation, not idle.
        observed: z
          .object({ band: z.enum(FLEET_BANDS), agentState: agentState.nullable() })
          .strip()
          .nullable()
          .default(null),
        // Absent from a host from before it was sent: the reader falls back to `observed`.
        runs: z
          .array(
            z
              .object({
                terminalId: id,
                band: z.enum(FLEET_BANDS),
                agentState: agentState.nullable(),
              })
              .strip()
          )
          .max(MAX_WORKTREE_RUNS)
          .optional(),
      })
      .strip()
  )
  .max(MAX_HOST_WORKTREES);

/** Bounds on a restart-impact answer: a list for a person to read, not an inventory. */
export const MAX_RESTART_PROJECTS = 200;
export const MAX_RESTART_IDS = 2000;
export const MAX_RESTART_SHELLS = 64;

const count = z.number().int().min(0).max(1_000_000);

export const RestartImpactDetailSchema = z
  .object({
    projects: z
      .array(
        z
          .object({
            projectName: name.nullable(),
            terminals: count,
            working: count,
            waiting: count,
          })
          .strip()
      )
      .max(MAX_RESTART_PROJECTS),
    complete: z.boolean(),
    operations: count,
    otherShells: z.array(name).max(MAX_RESTART_SHELLS),
    terminalIds: z.array(id).max(MAX_RESTART_IDS),
    shellIds: z.array(id).max(MAX_RESTART_SHELLS),
  })
  .strip();

export const RestartImpactSchema = z
  .object({
    detail: RestartImpactDetailSchema.nullable(),
    agents: z.object({ working: count, waiting: count.nullable() }).strip().nullable(),
  })
  .strip();

/** Bounds on a link-activity answer: a page for a person to read, not an inventory. */
export const MAX_ACTIVITY_DRIVERS = 200;
export const MAX_ACTIVITY_SHELLS = 64;
/** Enough for the last few sessions of every Shell a host serves, not a log. */
export const MAX_LINK_HISTORY = 100;
/** Reasons and details as a person reads them; a peer's GOODBYE can say more. */
export const MAX_LINK_HISTORY_TEXT = 256;

const epochMs = z.number().finite();
const clientName = z.string().max(256);
const historyText = z.string().max(MAX_LINK_HISTORY_TEXT);
const seen = { at: epochMs, clientId: id, clientName };

const LinkEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...seen,
      kind: z.literal("session-started"),
      sessionId: id,
      previousNotResumed: z
        .enum(["session-unknown", "secret-mismatch", "client-mismatch"])
        .nullable(),
    })
    .strip(),
  z
    .object({
      ...seen,
      kind: z.literal("session-resumed"),
      sessionId: id,
      overLiveLink: z.boolean(),
    })
    .strip(),
  z
    .object({
      ...seen,
      kind: z.literal("link-dropped"),
      sessionId: id,
      reason: historyText,
      by: z.enum(["local", "remote", "transport"]),
    })
    .strip(),
  z
    .object({
      ...seen,
      kind: z.literal("session-ended"),
      sessionId: id,
      cause: z.enum([
        "goodbye",
        "protocol-error",
        "grace-expired",
        "session-cap",
        "session-replaced",
        "host-shutdown",
      ]),
      reason: historyText.nullable(),
    })
    .strip(),
  z
    .object({
      ...seen,
      kind: z.literal("refused"),
      reason: z.enum(["unauthorized", "version-mismatch", "protocol", "busy", "shutting-down"]),
      detail: historyText.nullable(),
      count: count.min(1),
      lastAt: epochMs,
    })
    .strip(),
]);

export const LinkActivitySchema = z
  .object({
    observedAt: epochMs,
    listeningSince: epochMs.nullable(),
    version: z.string().max(256),
    commit: z.string().max(256),
    // An event a newer host adds is one this Shell can't name: dropped, not fatal.
    events: z
      .array(z.unknown())
      .max(MAX_LINK_HISTORY)
      .transform((events) =>
        events.flatMap((event) => {
          const parsed = LinkEventSchema.safeParse(event);
          return parsed.success ? [parsed.data] : [];
        })
      ),
    eventsTruncated: z.boolean(),
    drivers: z.array(DriverObservationSchema.strip()).max(MAX_ACTIVITY_DRIVERS),
    attached: z
      .array(
        z
          .object({
            sessionId: id,
            clientId: id,
            clientName,
            platform: z.enum(["darwin", "linux", "win32"]),
            connectedAt: epochMs,
            drivingProjectIds: z.array(id).max(MAX_ACTIVITY_DRIVERS),
          })
          .strip()
      )
      .max(MAX_ACTIVITY_SHELLS),
  })
  .strip();
