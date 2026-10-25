import { z } from "zod";
import { SendKeysArgsSchema } from "../utils/terminalKeys.js";

/**
 * Throwaway host agents (#14443, contract #14444): a short-lived agent a
 * Shell's assistant starts on a host through `host.call` with `throwaway`
 * instead of a `projectId`, uses for a minute, and closes. The host runs it
 * in one folder of its own outside every repository, with no view and no
 * project, so it reaches no project, worktree or forge and shows in no
 * project's lists. It still runs with the person's own CLI config: the folder
 * keeps a check out of projects, it is not a sandbox.
 *
 * - Only the session that launched a run may act on it: the Shell sender the
 *   host authenticated and that sender's help session, never a link session,
 *   an adoption or a project's ownership. Any other caller, on the same Shell
 *   or another, is told `not-found`, as for a run that never existed.
 * - Closing ends the process. No trash, no recovery and no grace: once close
 *   answers, the run and its output are gone, and a fresh close is `not-found`.
 * - A run's age and time limit are the host's own readings (see
 *   {@link HostThrowawayRunSchema}), so a Shell never works them out on its own clock.
 * - These tools exist only on this target. They are not actions, not MCP tools
 *   and never offered on any tier; a project call never reaches them.
 */

export const THROWAWAY_LAUNCH_TOOL = "throwaway.launch";
export const THROWAWAY_STATUS_TOOL = "throwaway.status";
export const THROWAWAY_OUTPUT_TOOL = "throwaway.output";
export const THROWAWAY_SEND_COMMAND_TOOL = "throwaway.sendCommand";
export const THROWAWAY_SEND_KEYS_TOOL = "throwaway.sendKeys";
export const THROWAWAY_CLOSE_TOOL = "throwaway.close";

export const HOST_THROWAWAY_TOOLS = [
  THROWAWAY_LAUNCH_TOOL,
  THROWAWAY_STATUS_TOOL,
  THROWAWAY_OUTPUT_TOOL,
  THROWAWAY_SEND_COMMAND_TOOL,
  THROWAWAY_SEND_KEYS_TOOL,
  THROWAWAY_CLOSE_TOOL,
] as const;
export type HostThrowawayTool = (typeof HOST_THROWAWAY_TOOLS)[number];

/** Each throwaway tool with its arguments, as a refusal names them for a caller to pick from. */
export const HOST_THROWAWAY_TOOL_SIGNATURES =
  "throwaway.launch {agentId, timeLimitMs?}, throwaway.status {runId}, throwaway.output {runId, maxLines?}, throwaway.sendCommand {runId, command}, throwaway.sendKeys {runId, keys}, throwaway.close {runId}";

/** Longest time limit a launch may ask for. */
export const MAX_THROWAWAY_TIME_LIMIT_MS = 15 * 60_000;
/** A launch's time limit when it asks for none (#14447): long enough for one check. */
export const DEFAULT_THROWAWAY_TIME_LIMIT_MS = 5 * 60_000;
/** Most lines one output read returns. */
export const MAX_THROWAWAY_OUTPUT_LINES = 1_000;
/** Longest command one send may type. */
export const MAX_THROWAWAY_COMMAND_CHARS = 16 * 1024;

const id = z.string().min(1).max(256);
const count = z.number().int().min(0);
const timeLimit = z.number().int().min(1_000).max(MAX_THROWAWAY_TIME_LIMIT_MS);
const runArgs = { runId: id };

/** The keys `terminal.sendKeys` takes, and no more. */
const keyNames = SendKeysArgsSchema.shape.keys.unwrap();

/**
 * One throwaway tool with its arguments. A run is named only by the host's
 * own `runId`: never a terminal or panel id, and a launch takes no folder,
 * environment, executable, preset, worktree or MCP option of the caller's.
 */
export const HostThrowawayCallSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal(THROWAWAY_LAUNCH_TOOL),
      args: z
        .object({
          /** A launchable agent on the host, such as `claude`; the host checks it is there. */
          agentId: id,
          /**
           * Lowers the host's default limit, up to the ceiling. Refused as
           * `expiry-unsupported` by a host from before time limits.
           */
          timeLimitMs: timeLimit.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ tool: z.literal(THROWAWAY_STATUS_TOOL), args: z.object(runArgs).strict() }).strict(),
  z
    .object({
      tool: z.literal(THROWAWAY_OUTPUT_TOOL),
      args: z
        .object({
          ...runArgs,
          maxLines: z.number().int().min(1).max(MAX_THROWAWAY_OUTPUT_LINES).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal(THROWAWAY_SEND_COMMAND_TOOL),
      args: z
        .object({ ...runArgs, command: z.string().min(1).max(MAX_THROWAWAY_COMMAND_CHARS) })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal(THROWAWAY_SEND_KEYS_TOOL),
      args: z.object({ ...runArgs, keys: keyNames }).strict(),
    })
    .strict(),
  z.object({ tool: z.literal(THROWAWAY_CLOSE_TOOL), args: z.object(runArgs).strict() }).strict(),
]);
export type HostThrowawayCall = z.infer<typeof HostThrowawayCallSchema>;

/**
 * A run as its host reads it at the moment it answers. `ageMs` stops growing
 * once the process ends. The time limit and its deadline are both null or
 * both set: null only from a host from before time limits (#14447), and once
 * set, `expiresAt` is `startedAt + timeLimitMs`, which nothing a caller does
 * moves. Once it passes, the host ends the run whatever state it is in and
 * the run reads as not found, as one closed.
 */
export const HostThrowawayRunSchema = z
  .object({
    runId: id,
    agentId: id,
    startedAt: count,
    ageMs: count,
    timeLimitMs: timeLimit.nullable(),
    expiresAt: count.nullable(),
    state: z.enum(["running", "exited", "closed"]),
    endedAt: count.nullable(),
    /** Why it ended: its own exit, a close, or its time limit. Null while running. */
    endReason: z.enum(["exit", "close", "expiry"]).nullable(),
  })
  .strip()
  .refine((run) => (run.timeLimitMs === null) === (run.expiresAt === null))
  .refine((run) => (run.state === "running") === (run.endedAt === null))
  .refine((run) => (run.endedAt === null) === (run.endReason === null));
export type HostThrowawayRun = z.infer<typeof HostThrowawayRunSchema>;

/** What a throwaway tool answers when it ran: the run as it stands, and the tool's own fields. */
export const HostThrowawayToolResultSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal(THROWAWAY_LAUNCH_TOOL), run: HostThrowawayRunSchema }).strip(),
  z.object({ tool: z.literal(THROWAWAY_STATUS_TOOL), run: HostThrowawayRunSchema }).strip(),
  z
    .object({
      tool: z.literal(THROWAWAY_OUTPUT_TOOL),
      run: HostThrowawayRunSchema,
      /** The terminal's text as observed, last lines last. */
      content: z.string(),
      lineCount: count,
      truncated: z.boolean(),
    })
    .strip(),
  /** Typed into the terminal; not that the agent acted on it. */
  z
    .object({
      tool: z.literal(THROWAWAY_SEND_COMMAND_TOOL),
      run: HostThrowawayRunSchema,
      accepted: z.literal(true),
    })
    .strip(),
  z
    .object({
      tool: z.literal(THROWAWAY_SEND_KEYS_TOOL),
      run: HostThrowawayRunSchema,
      accepted: z.literal(true),
    })
    .strip(),
  /** Sent only once the process has ended and the run is gone, so its run reads closed. */
  z
    .object({
      tool: z.literal(THROWAWAY_CLOSE_TOOL),
      run: HostThrowawayRunSchema,
      closed: z.literal(true),
    })
    .strip()
    .refine((result) => result.run.state === "closed"),
]);
export type HostThrowawayToolResult = z.infer<typeof HostThrowawayToolResultSchema>;

/**
 * A throwaway tool that ran and failed. `not-found` is also every run that
 * isn't the caller's own; `exited` is input sent to a run whose process ended.
 */
export const HOST_THROWAWAY_FAILURES = [
  "not-found",
  "exited",
  "launch-failed",
  "input-failed",
  "close-failed",
] as const;
export type HostThrowawayFailure = (typeof HOST_THROWAWAY_FAILURES)[number];

/**
 * Why a host refused a throwaway call before anything ran. `throwaway-off`
 * is a host that has them turned off or can't run them, `expiry-unsupported`
 * a launch asking for a time limit a host from before #14447 can't keep. Both
 * read as `unsupported` to the caller, never as a failure.
 */
export const HOST_THROWAWAY_REFUSALS = [
  "control-off",
  "throwaway-off",
  "expiry-unsupported",
] as const;
export type HostThrowawayRefusal = (typeof HOST_THROWAWAY_REFUSALS)[number];
