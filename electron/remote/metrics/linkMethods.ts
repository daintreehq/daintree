import { z } from "zod";
import { FLEET_BANDS } from "../../../shared/utils/fleetBands.js";
import { BUILT_IN_AGENT_IDS } from "../../../shared/config/agentIds.js";
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
  /**
   * Host → Shell: an agent on the host needs someone. The host reports it; the
   * Shell decides by its own settings and presents it (#14701).
   */
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
   * Host → Shell: the projects registered on the host changed (one added,
   * removed, moved or renamed), so which of them match a Shell's project may
   * have. Carries nothing. Agent activity never sends it. A Shell from before
   * it existed refuses the call, which the host ignores.
   */
  PROJECTS_CHANGED: "host.projects-changed",
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
  /**
   * Shell → Host: the processes this host runs, as its Processes view lists
   * them. Observation only: nothing over the link ends any of them. A host
   * from before it existed answers UNSUPPORTED.
   */
  PROCESS_INVENTORY: "host.process-inventory",
} as const;

const id = z.string().min(1).max(256);
const name = z.string().max(1024);

export const AttentionPayloadSchema = z.object({
  kind: z.literal("waiting"),
  terminalId: id,
  /** Absent from a host older than this field; the Shell reads that as unknown. */
  projectId: id.nullish(),
  projectName: name.nullable(),
  agentName: name.nullable(),
  /**
   * The host's own quiet hours hold this back, for a Shell that left the
   * verdict to it: the Shell files it in the inbox without a toast. False
   * when the Shell decides for itself.
   */
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

/** Bounds on a process-inventory answer, so a busy host can't flood a Shell. */
export const MAX_PROCESS_TERMINALS = 500;
/** The heaviest members of one tree; the host's census already keeps no more. */
export const MAX_PROCESS_MEMBERS = 10;
/** The pty-host's own cap on the closed processes it records. */
export const MAX_PROCESS_CLOSED = 256;
export const MAX_PROCESS_PLUGINS = 256;
/** Executable basenames and plugin labels. */
export const MAX_PROCESS_LABEL = 256;
/**
 * What the rows of one answer may encode to, by the link's own encoder: half
 * the link's frame, since the list bounds alone still allow more than a frame
 * of long multibyte text, and the rest is ample for the envelope.
 */
export const MAX_PROCESS_INVENTORY_BYTES = 8 * 1024 * 1024;

const pid = z.number().int().min(0);
const reading = z.number().finite().min(0);
const label = z.string().max(MAX_PROCESS_LABEL);
/** A running total, which a long-lived host can carry past any display bound. */
const tally = z.number().int().min(0);

const ProcessTreeSampleSchema = z
  .object({
    cpuPercent: reading,
    memoryKb: reading,
    processCount: tally,
    members: z
      .array(z.object({ pid, comm: label, cpuPercent: reading, memoryKb: reading }).strip())
      .max(MAX_PROCESS_MEMBERS),
  })
  .strip();

const agentTree = z.enum(["runtime-and-servers", "other", "unknown"]);

const ProcessTerminalSchema = z
  .object({
    id,
    projectId: id.nullable(),
    projectName: name.nullable(),
    kind: label.optional(),
    title: name.optional(),
    cwd: z.string().max(4096),
    worktreeId: z.string().max(4096).optional(),
    launchAgentId: id.optional(),
    // An agent a newer host detects is one this Shell can't name.
    detectedAgentId: z.enum(BUILT_IN_AGENT_IDS).optional().catch(undefined),
    isAssistantTerminal: z.boolean(),
    spawnedAt: epochMs,
    isTrashed: z.boolean(),
    trashExpiresAt: epochMs.optional(),
    rootPid: pid.nullable(),
    sample: ProcessTreeSampleSchema.nullable(),
    agentTree: agentTree.optional().catch("unknown"),
  })
  .strip();

const ClosedProcessSchema = z
  .object({
    pid,
    startTime: z.string().min(1).max(256),
    comm: label,
    memoryKb: reading.nullable(),
    cpuPercent: reading.nullable(),
    origin: z
      .object({
        kind: z.enum(["terminal", "plugin"]),
        id,
        projectId: id.optional(),
        title: name.optional(),
        panelKind: label.optional(),
        launchAgentId: id.optional(),
        spawnedAt: epochMs.optional(),
      })
      .strip()
      .nullable(),
    closedAt: epochMs,
    projectName: name.nullable(),
  })
  .strip();

const PluginProcessSchema = z
  .object({
    source: z.enum(["plugin-process", "plugin-worker"]),
    id,
    pluginId: id,
    label: label.nullable(),
    pid,
    spawnedAt: epochMs.nullable(),
    sample: ProcessTreeSampleSchema.nullable(),
  })
  .strip();

/** Rows read one at a time: one this Shell can't take is left out, not fatal to the rest. */
function rowsOf<T extends z.ZodType>(row: T, max: number) {
  return z
    .array(z.unknown())
    .max(max)
    .transform((rows) => {
      const kept: Array<z.output<T>> = [];
      for (const raw of rows) {
        const parsed = row.safeParse(raw);
        if (parsed.success) kept.push(parsed.data);
      }
      return { kept, dropped: rows.length - kept.length };
    });
}

export const ProcessInventorySchema = z
  .object({
    terminals: rowsOf(ProcessTerminalSchema, MAX_PROCESS_TERMINALS),
    closedTerminalProcesses: rowsOf(ClosedProcessSchema, MAX_PROCESS_CLOSED),
    cleanup: z
      .object({
        found: tally,
        ended: tally,
        stillRunning: tally,
        unchecked: tally,
        lastAt: epochMs,
      })
      .strip()
      .nullable(),
    plugins: rowsOf(PluginProcessSchema, MAX_PROCESS_PLUGINS),
    complete: z.boolean(),
    samplesAvailable: z.boolean(),
    sampledAt: epochMs,
    truncated: z.boolean(),
  })
  .strip()
  .transform(({ terminals, closedTerminalProcesses, plugins, truncated, ...rest }) => ({
    ...rest,
    terminals: terminals.kept,
    closedTerminalProcesses: closedTerminalProcesses.kept,
    plugins: plugins.kept,
    truncated:
      truncated ||
      terminals.dropped > 0 ||
      closedTerminalProcesses.dropped > 0 ||
      plugins.dropped > 0,
  }));
