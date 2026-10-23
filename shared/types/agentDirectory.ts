import { z } from "zod";
import { MAX_ASSISTANT_SLOTS } from "../config/assistantSlots.js";

/**
 * The agent directory (#14160): one typed, passive list of a host's workers and
 * Daintree Assistants for first-party callers (Canopy, the assistant picker,
 * `host.list`'s optional agent inventory). It is a separate projection from the
 * fleet and the worker listings, which keep excluding assistants; it grants no
 * authority over what it names and starts, resumes or reads nothing to list it.
 *
 * Role is never the agent: a worker and an assistant can both run `claude`.
 * Every field is something main observed or holds; none is a conclusion drawn
 * from them. Terminal contents, handback text, credentials and paths are not
 * directory data.
 */

/** Most entries one host's directory names; the rest are counted in `omitted`. */
export const AGENT_DIRECTORY_ENTRIES_MAX = 256;
/** Longest display label kept; a longer one is cut. */
export const AGENT_DIRECTORY_LABEL_MAX = 120;
/** Most projects whose resumable assistants one read looks up. */
export const AGENT_DIRECTORY_RESUMABLE_PROJECTS_MAX = 50;
/**
 * The compact JSON a full directory fits in. The cap on entries and labels
 * keeps a host under it by construction; it bounds the MCP result, whose text
 * is capped at 50 KiB, with room for the rest of `host.list`.
 */
export const AGENT_DIRECTORY_BYTES_MAX = 48 * 1024;

const hostIdSchema = z.string().min(1).max(64);
const idSchema = z.string().min(1).max(256);
const laneSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ASSISTANT_SLOTS - 1);

/** A project, or the one global assistant of an install, which is no project and no host's. */
export const AgentDirectoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: idSchema }),
  z.object({ kind: z.literal("global") }),
]);
export type AgentDirectoryScope = z.infer<typeof AgentDirectoryScopeSchema>;

/**
 * A live run, exactly. `incarnation` is the run's launch generation: a terminal
 * id reused after a kill or a restart carries a new one, so a target that
 * named the old run no longer matches. The same terminal id on two hosts is two
 * subjects, told apart by `hostId`.
 */
export const AgentDirectorySubjectSchema = z.object({
  hostId: hostIdSchema,
  scope: AgentDirectoryScopeSchema,
  terminalId: idSchema,
  incarnation: z.number().int().nonnegative(),
  /** A project assistant's lane (slot); absent for a worker. */
  lane: laneSchema.optional(),
});
export type AgentDirectorySubject = z.infer<typeof AgentDirectorySubjectSchema>;

const agentStateSchema = z.enum(["idle", "working", "waiting", "directing", "completed", "exited"]);
const waitingReasonSchema = z.enum(["prompt", "question", "approval", "error"]);

export const AgentDirectoryLiveEntrySchema = z.object({
  state: z.literal("live"),
  role: z.enum(["worker", "assistant"]),
  subject: AgentDirectorySubjectSchema,
  /** The agent implementation, as last observed or launched; not the role. */
  agentId: z.string().nullable(),
  agentState: agentStateSchema.nullable(),
  waitingReason: waitingReasonSchema.nullable(),
  /** Epoch ms of the last observed state change. */
  since: z.number().nullable(),
  /** The pane's own title, cut to a short label; null when it has none. */
  label: z.string().nullable(),
  /** An assistant shown in a window here; false while it runs with no view; null for a worker. */
  attached: z.boolean().nullable(),
  /** When the run last reported a handback marker, without its text; null if never observed. */
  handback: z.object({ observedAt: z.number() }).nullable(),
});
export type AgentDirectoryLiveEntry = z.infer<typeof AgentDirectoryLiveEntrySchema>;

/**
 * An assistant conversation main holds a resume pointer for, with no process
 * running. It names no terminal and no incarnation, so nothing can target it
 * as a live run; resuming it is the person's own explicit action.
 */
export const AgentDirectoryResumableEntrySchema = z.object({
  state: z.literal("resumable"),
  role: z.literal("assistant"),
  hostId: hostIdSchema,
  scope: z.object({ kind: z.literal("project"), projectId: idSchema }),
  lane: laneSchema,
  agentId: z.string().nullable(),
  /** Epoch ms the pointer was recorded. */
  capturedAt: z.number(),
});
export type AgentDirectoryResumableEntry = z.infer<typeof AgentDirectoryResumableEntrySchema>;

export const AgentDirectoryEntrySchema = z.discriminatedUnion("state", [
  AgentDirectoryLiveEntrySchema,
  AgentDirectoryResumableEntrySchema,
]);
export type AgentDirectoryEntry = z.infer<typeof AgentDirectoryEntrySchema>;

/**
 * What a read of one host covered. Only `ok` with `complete` and no `omitted`
 * is a full inventory, the one an absent entry may be read from; an empty list
 * under anything else says nothing about what runs.
 *
 * - `ok`: read now.
 * - `stale`: the read failed; the entries are the last known, from `observedAt`.
 * - `unreachable`: no link, and nothing known to show.
 * - `unsupported`: the host can't be read this way: too old, or this Shell
 *   doesn't read its agents yet.
 */
export const AGENT_DIRECTORY_COVERAGE = ["ok", "stale", "unreachable", "unsupported"] as const;
export type AgentDirectoryCoverage = (typeof AGENT_DIRECTORY_COVERAGE)[number];

export const AgentDirectorySchema = z.object({
  coverage: z.enum(AGENT_DIRECTORY_COVERAGE),
  /** Epoch ms the entries were observed; not when they were returned. Null with no entries known. */
  observedAt: z.number().nullable(),
  /** Every source answered. False when a pty shard did not, so entries may be missing. */
  complete: z.boolean(),
  /** Entries left out for the cap on entries, after the project filter. */
  omitted: z.number().int().nonnegative(),
  entries: z.array(AgentDirectoryEntrySchema),
});
export type AgentDirectory = z.infer<typeof AgentDirectorySchema>;

/** Never a full inventory: nothing was read, or what was read can't be the whole. */
export function unreadAgentDirectory(
  coverage: Exclude<AgentDirectoryCoverage, "ok" | "stale">
): AgentDirectory {
  return { coverage, observedAt: null, complete: false, omitted: 0, entries: [] };
}

/** Whether an empty `entries` may be read as "nothing runs". */
export function isFullAgentDirectory(directory: AgentDirectory): boolean {
  return directory.coverage === "ok" && directory.complete && directory.omitted === 0;
}

export function cutAgentLabel(label: string | undefined | null): string | null {
  const text = label?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > AGENT_DIRECTORY_LABEL_MAX
    ? `${text.slice(0, AGENT_DIRECTORY_LABEL_MAX - 1)}…`
    : text;
}

/**
 * Keeps the leading entries whose compact JSON fits `maxBytes`, counting the
 * rest in `omitted`; live entries lead, so resumable ones are cut first.
 */
export function fitAgentDirectory(
  directory: AgentDirectory,
  maxBytes: number = AGENT_DIRECTORY_BYTES_MAX
): AgentDirectory {
  const encoder = new TextEncoder();
  let used = encoder.encode(JSON.stringify({ ...directory, entries: [] })).length;
  let kept = 0;
  for (const entry of directory.entries) {
    used += encoder.encode(JSON.stringify(entry)).length + 1;
    if (used > maxBytes) break;
    kept += 1;
  }
  if (kept === directory.entries.length) return directory;
  return {
    ...directory,
    omitted: directory.omitted + directory.entries.length - kept,
    entries: directory.entries.slice(0, kept),
  };
}
