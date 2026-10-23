import { z } from "zod";
import { AGENT_DIRECTORY_COVERAGE, AgentDirectorySubjectSchema } from "./agentDirectory.js";

/**
 * Which workers a Daintree Assistant made or was handed (#14166): a first
 * party projection for Canopy, kept apart from the agent directory, whose
 * shape is `host.list`'s public contract. It grants nothing: every action on a
 * worker still passes the ownership ledger and the hand-over record it was
 * read from.
 *
 * Two facts per worker, never merged:
 * - `createdBy`: the assistant whose trusted dispatch created this exact run.
 *   It stays after that assistant ends or loses its authority.
 * - `controlledBy`: who holds authority over the run now, by the ownership
 *   ledger (`creation`) or a person's hand-over (`handover`); null when no
 *   assistant does.
 *
 * Only main's own records feed it: a terminal's client metadata, title,
 * branch or model never does.
 */

/** Most workers one host's reading names; the rest are counted in `omitted`. */
export const ASSISTANT_WORK_WORKERS_MAX = 256;

/** The assistant work protocol a host speaks; a host without it has none. */
export const ASSISTANT_WORK_VERSION = 1;

const idSchema = z.string().min(1).max(256);
const hexSchema = z
  .string()
  .regex(/^[0-9a-f]{1,128}$/)
  .or(z.literal("local"));

/**
 * An assistant as the worker's host names it.
 * - `assistant`: a live assistant on that host, as its exact run.
 * - `ended`: an assistant of that host whose session has ended; nothing names it now.
 * - `relay`: a Shell's assistant, reaching the host through `host.call`. Only
 *   the Shell that proved `senderId` can tell which, by `sessionKey`.
 */
export const AssistantWorkHostRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assistant"), subject: AgentDirectorySubjectSchema }),
  z.object({ kind: z.literal("ended") }),
  z.object({ kind: z.literal("relay"), senderId: hexSchema, sessionKey: hexSchema }),
]);
export type AssistantWorkHostRef = z.infer<typeof AssistantWorkHostRefSchema>;

/**
 * An assistant as this Shell names it: `relay` is resolved to one of its own,
 * to `ended` when it was its own and is gone, or to another installation's,
 * which this Shell can't name.
 */
export type AssistantWorkRef =
  | { kind: "assistant"; subject: z.infer<typeof AgentDirectorySubjectSchema> }
  | { kind: "ended" }
  | { kind: "other-installation" };

const workerSchema = <R extends z.ZodTypeAny>(ref: R) =>
  z.object({
    terminalId: idSchema,
    projectId: idSchema,
    /** The run's launch generation, as main checked it against its records. */
    incarnation: z.number().int().nonnegative(),
    /** The run's spawn time, which Canopy's rows carry: it tells a reused id's runs apart. */
    spawnedAt: z.number(),
    createdBy: ref.nullable(),
    controlledBy: ref.nullable(),
    /** What `controlledBy` stands on; null with it. */
    control: z.enum(["creation", "handover"]).nullable(),
  });

export const AssistantWorkHostReadingSchema = z.object({
  coverage: z.enum(AGENT_DIRECTORY_COVERAGE),
  observedAt: z.number().nullable(),
  /** Every source answered; false when a pty shard did not, so workers may be missing. */
  complete: z.boolean(),
  omitted: z.number().int().nonnegative(),
  /** Only workers some assistant made or holds: any other has no link to show. */
  workers: z.array(workerSchema(AssistantWorkHostRefSchema)).max(ASSISTANT_WORK_WORKERS_MAX),
});
export type AssistantWorkHostReading = z.infer<typeof AssistantWorkHostReadingSchema>;
export type AssistantWorkHostWorker = AssistantWorkHostReading["workers"][number];

export interface AssistantWorkWorker extends Omit<
  AssistantWorkHostWorker,
  "createdBy" | "controlledBy"
> {
  createdBy: AssistantWorkRef | null;
  controlledBy: AssistantWorkRef | null;
}

/** One host's reading as this Shell names everything in it. */
export interface AssistantWorkReading extends Omit<AssistantWorkHostReading, "workers"> {
  workers: AssistantWorkWorker[];
}

/** Nothing read: it names no worker, and is never a full reading. */
export function unreadAssistantWork(
  coverage: "unreachable" | "unsupported"
): Omit<AssistantWorkReading, "workers"> & { workers: never[] } {
  return { coverage, observedAt: null, complete: false, omitted: 0, workers: [] };
}

/** Whether a worker missing from the reading may be read as linked to no assistant. */
export function isFullAssistantWork(reading: AssistantWorkReading): boolean {
  return reading.coverage === "ok" && reading.complete && reading.omitted === 0;
}
