/**
 * The Claude subagent list exactly as it stood before #15681, frozen as the
 * oracle PERF-414..418 grade the shipped reader against and as the reference
 * arm they measure beside it.
 *
 * Copied by line range from `electron/services/claude/ClaudeSubagentReader.ts`
 * at 02bd9c012c, not retyped, and deliberately importing nothing from the
 * shipped module: an oracle that shared the parser or the status rule with its
 * subject would agree with it about every bug the two have in common. Its probe
 * cache is its own, FIFO and capped at 256 entries, so the reference arm
 * reproduces the cliff the issue measured rather than borrowing the fix.
 *
 * Nothing here may change except to stay compilable. A behaviour change belongs
 * in the shipped reader, where this copy will then flag it as a difference.
 */

import { lstat, open, readdir } from "fs/promises";
import path from "path";
import {
  SUBAGENT_LIST_LIMIT,
  SUBAGENT_MESSAGE_MAX_CHARS,
  type AgentSubagent,
  type AgentSubagentStatus,
} from "../../../shared/types/ipc/agentSubagents";

export const REFERENCE_PROVENANCE = "02bd9c012c";

/**
 * How long after its last write a half-finished child is still called
 * "working". Past this it becomes `unknown`, not failed — a file that stopped
 * mid-tool-call looks identical whether the child died or is three minutes into
 * a test run, and the disk cannot tell the two apart. The window is generous
 * because the wrong answer in one direction ("Unknown" for a live child) is
 * only unhelpful, while the other ("Working" forever) is misleading.
 */
export const CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS = 2 * 60_000;

/** Bytes read from each end of a transcript when listing. Enough for a record, bounded against a huge file. */
const LIST_PROBE_BYTES = 128 * 1024;
/** Cap on a `.meta.json` read — the real ones are one short line. */
const META_MAX_BYTES = 64 * 1024;
/** Cap on any one string lifted out of a sidecar, so a bloated field can't ride to the renderer. */
const META_FIELD_MAX_CHARS = 500;
/** Concurrent per-child reads. A session can hold dozens of children; opening them all at once helps nobody. */
const LIST_CONCURRENCY = 8;
/** Parsed-probe entries retained across calls, keyed by file identity. */
const PROBE_CACHE_MAX = 256;

/** Injection seam for tests: a config root and a clock, nothing else. */
export interface ClaudeSubagentReaderOptions {
  configDir?: string;
  now?: () => number;
}

/**
 * Absence is normal here — a session that never delegated has no directory, and
 * a child can be removed between the readdir and the read. Everything else
 * (a permission wall, a failing disk) is a real failure, and reporting it as
 * "no children" would be indistinguishable from the ordinary case.
 */
function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== "." && value !== "..";
}

/** Child ids appear in a filename, so anything that could steer a path is refused outright. */
export function isSafeSubagentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

async function regularFileMtime(target: string): Promise<number | null> {
  try {
    // `lstat` for the same reason as the transcript: a sidecar is a plain file.
    const stats = await lstat(target);
    return stats.isFile() ? Math.round(stats.mtimeMs) : null;
  } catch {
    return null;
  }
}

interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  model: string | null;
  depth: number | null;
  createdAt: number | null;
}

const EMPTY_META: SubagentMeta = {
  agentType: null,
  description: null,
  model: null,
  depth: null,
  createdAt: null,
};

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, META_FIELD_MAX_CHARS) : null;
}

/**
 * `general-purpose` is a slug, and a slug is not a label. Only Claude records
 * its worker kind this way, so the conversion belongs here rather than in the
 * shared display layer, where it would also catch Codex's free-text roles.
 */
export function humanizeAgentType(value: string | null): string | null {
  const text = asText(value);
  if (!text) return null;
  const spaced = text.replace(/[-_]+/g, " ").trim();
  if (!spaced) return null;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function parseSubagentMeta(raw: string, createdAt: number | null): SubagentMeta {
  let parsed: unknown;
  try {
    // A BOM is not JSON; strip it rather than lose every field to it.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    // The sidecar is uncontracted; a malformed one costs its fields, not the row.
    return { ...EMPTY_META, createdAt };
  }
  // An array is an object to `typeof`, and its indices are not the fields we want.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...EMPTY_META, createdAt };
  }
  const meta = parsed as Record<string, unknown>;
  const depth = meta.spawnDepth;
  return {
    agentType: asText(meta.agentType),
    // Present only when the caller supplied one, which is often not the case.
    description: asText(meta.description),
    model: asText(meta.model),
    depth: typeof depth === "number" && Number.isFinite(depth) ? depth : null,
    createdAt,
  };
}

interface ParsedRecord {
  type: string | null;
  message: { content?: unknown; stop_reason?: unknown } | null;
  timestamp: number | null;
}

function parseRecord(line: string): ParsedRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // An array parses fine and is an object, but it is not a record.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const message = record.message;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return {
    type: typeof record.type === "string" ? record.type : null,
    message: message && typeof message === "object" ? (message as ParsedRecord["message"]) : null,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  };
}

/**
 * Pull the readable prose out of one record's `message.content`.
 *
 * `content` is a bare string on the delegated prompt and a block array
 * everywhere else. Only `text` blocks are kept: `thinking` is the child's
 * scratchpad, and `tool_use`/`tool_result` are the mechanism rather than the
 * answer — and dumping raw tool output would put file contents into a popover.
 * Codex omits its own reasoning trace for the same reason.
 */
export function recordText(message: ParsedRecord["message"]): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text" || typeof entry.text !== "string") continue;
    const text = entry.text.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * Stop reasons that actually end a turn.
 *
 * An allowlist rather than "anything but `tool_use`", because the field is
 * uncontracted and the values that are not here argue against completion, not
 * for it: `max_tokens` and `pause_turn` mean the turn was cut off mid-thought.
 * A value nobody has seen before falls through to the activity check instead of
 * being promoted to "Done" on the strength of being unfamiliar.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "refusal",
]);

/**
 * Decide what a child is doing from its last record and when the file last
 * changed.
 *
 * There is no completion record — the file simply stops. A finished turn is an
 * `assistant` record whose `stop_reason` is one that ends a turn; anything else
 * is either still in flight or an unfinished step nobody can account for. The
 * third case is reported as unknown, never as an error: the disk offers no
 * evidence that a quiet child failed.
 *
 * `partialTail` is its own input because a half-written final line is evidence,
 * not noise. Reading past it to the last *parseable* record is how a child that
 * finished one turn and is streaming the next gets reported as finished.
 */
export function inferStatus(
  last: ParsedRecord | null,
  updatedAt: number,
  now: number,
  partialTail = false
): AgentSubagentStatus {
  const recentlyActive = now - updatedAt <= CLAUDE_SUBAGENT_ACTIVE_WINDOW_MS;
  // Something was mid-write when we looked, so whatever came before it is not
  // this child's last word.
  if (partialTail) {
    return recentlyActive ? { type: "working" } : { type: "unknown", reason: "stale" };
  }
  if (!last) return { type: "unknown", reason: "unrecognized" };
  if (last.type === "assistant") {
    const stop = last.message?.stop_reason;
    if (typeof stop === "string" && TERMINAL_STOP_REASONS.has(stop)) return { type: "completed" };
  }
  if (recentlyActive) return { type: "working" };
  return { type: "unknown", reason: "stale" };
}

interface Probe {
  first: ParsedRecord | null;
  last: ParsedRecord | null;
  /** The final line was mid-write, so `last` is not the child's last word. */
  partialTail: boolean;
}

interface CachedProbe extends Probe {
  fingerprint: string;
}

/**
 * Most children in a session are finished and will never change again, so the
 * probe they need is worth keeping. Keyed on mtime+size, which is what
 * `list` already had to `stat` — a child that writes another line simply misses.
 */
const probeCache = new Map<string, CachedProbe>();

function rememberProbe(key: string, fingerprint: string, probe: Probe): void {
  probeCache.set(key, { ...probe, fingerprint });
  while (probeCache.size > PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value;
    if (oldest === undefined) break;
    probeCache.delete(oldest);
  }
}

/** The probe cache is module state and outlives any one list call. */
export function resetReferenceProbeCache(): void {
  probeCache.clear();
}

/**
 * Read the first and last records of a transcript without reading the middle.
 *
 * Listing has to stay cheap across every child of a session, and the two ends
 * are all it needs: the opening record carries the delegated task, the closing
 * one carries the status.
 */
async function probeTranscript(file: string, size: number): Promise<Probe> {
  const handle = await open(file, "r");
  try {
    const headBytes = Buffer.alloc(Math.min(size, LIST_PROBE_BYTES));
    // Short reads happen; the unwritten tail of the buffer is NUL, not content.
    const head = await handle.read(headBytes, 0, headBytes.length, 0);
    const headText = headBytes.subarray(0, head.bytesRead).toString("utf8");
    const firstBreak = headText.indexOf("\n");
    // A file of one record and no trailing newline is still one whole record,
    // as long as the probe covered the whole file. Decided on the file's size
    // rather than on a short read: a file of exactly the probe window has been
    // read to its end too, and would otherwise lose its preview.
    const reachedEnd = size <= LIST_PROBE_BYTES;
    const firstLine =
      firstBreak === -1 ? (reachedEnd ? headText : "") : headText.slice(0, firstBreak);
    const first = parseRecord(firstLine);

    if (size <= LIST_PROBE_BYTES) return { first, ...finalRecord(headText, true) };

    const tailBytes = Buffer.alloc(LIST_PROBE_BYTES);
    const tail = await handle.read(tailBytes, 0, tailBytes.length, size - LIST_PROBE_BYTES);
    const tailText = tailBytes.subarray(0, tail.bytesRead).toString("utf8");
    return { first, ...finalRecord(tailText, false) };
  } finally {
    await handle.close();
  }
}

/**
 * Records that carry a turn of the conversation. Everything else in a
 * transcript — `attachment` (hook results, token reminders), `system`,
 * `progress`, `summary` and the rest — is bookkeeping the CLI writes around
 * the turns, including after the one that ended the child.
 */
const CONVERSATION_RECORD_TYPES: ReadonlySet<string> = new Set(["user", "assistant"]);

/**
 * The last conversation record in a chunk, and whether the chunk ended whole.
 *
 * Parseable bookkeeping records are stepped over, because the CLI writes them
 * after a finished turn: a child that ended on `end_turn` and then logged a
 * hook result is still a child that ended. An unparseable line is never
 * stepped over. As the newest line it is a record mid-write, reported as a
 * partial tail so the caller falls back to file activity — walking past it to
 * an older `end_turn` is what would report a child streaming its next turn as
 * finished. Further up, it is a line nobody can account for, and the older
 * record behind it is no longer evidence of the child's last word either.
 *
 * A chunk that starts mid-file opens on a fragment, so its first line is never
 * read as a record.
 */
function finalRecord(
  chunk: string,
  fromStart: boolean
): { last: ParsedRecord | null; partialTail: boolean } {
  const lines = chunk.split("\n");
  const floor = fromStart ? 0 : 1;
  let newest = true;
  for (let index = lines.length - 1; index >= floor; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const record = parseRecord(line);
    if (!record) return { last: null, partialTail: newest };
    newest = false;
    if (record.type !== null && CONVERSATION_RECORD_TYPES.has(record.type)) {
      return { last: record, partialTail: false };
    }
  }
  return { last: null, partialTail: false };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

/**
 * List the children recorded for one session, newest activity first.
 *
 * A directory that isn't there yet is not a failure — it is what every session
 * looks like before its first delegation, and the caller reports an empty list.
 */
export async function listSubagentsInDir(
  dir: string,
  options: ClaudeSubagentReaderOptions = {}
): Promise<AgentSubagent[]> {
  const now = options.now?.() ?? Date.now();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // A directory that isn't there is an empty list. A directory that refuses
    // to be read is a failure, and the caller says so rather than showing zero.
    if (isAbsence(error)) return [];
    throw error;
  }

  const ids: string[] = [];
  for (const entry of entries) {
    const match = AGENT_FILE.exec(entry);
    if (match?.[1] && isSafeSubagentId(match[1])) ids.push(match[1]);
  }

  const children = await mapPool(ids, LIST_CONCURRENCY, async (id) => {
    const file = path.join(dir, `agent-${id}.jsonl`);
    let size: number;
    let updatedAt: number;
    let ino: number;
    let ctime: number;
    try {
      // `lstat`, not `stat`: `stat` follows the link and reports the target,
      // so a symlink pointing at another session's transcript would pass an
      // `isFile` check on the thing it points at. A real transcript is a plain
      // file that Claude Code wrote here.
      const stats = await lstat(file);
      if (!stats.isFile()) return null;
      size = stats.size;
      updatedAt = Math.round(stats.mtimeMs);
      ino = stats.ino;
      ctime = Math.round(stats.ctimeMs);
    } catch {
      // One child vanishing mid-list costs its row; the directory read below is
      // what decides whether the store as a whole is readable.
      return null;
    }

    const meta = await readMeta(path.join(dir, `agent-${id}.meta.json`));

    // Size and mtime alone can repeat across an atomic replace; the inode and
    // ctime are what make the fingerprint about *this* file.
    const fingerprint = `${updatedAt}:${size}:${ino}:${ctime}`;
    const cached = probeCache.get(file);
    let probe: Probe;
    if (cached && cached.fingerprint === fingerprint) {
      probe = { first: cached.first, last: cached.last, partialTail: cached.partialTail };
    } else {
      try {
        probe = await probeTranscript(file, size);
      } catch {
        return null;
      }
      rememberProbe(file, fingerprint, probe);
    }

    return {
      id,
      // The description the parent wrote is a real label; the agent type is a
      // category. Preferring the former is why a row reads "Run the palette
      // suite" instead of "General purpose" thirty times over.
      label: meta.description,
      role: humanizeAgentType(meta.agentType),
      preview: recordText(probe.first?.message ?? null).slice(0, SUBAGENT_MESSAGE_MAX_CHARS),
      model: meta.model,
      depth: meta.depth,
      status: inferStatus(probe.last, updatedAt, now, probe.partialTail),
      // The sidecar is written once at spawn and never rewritten, so its mtime
      // is a clean birth time; the transcript's own first record is the
      // fallback when there is no sidecar.
      createdAt: meta.createdAt ?? probe.first?.timestamp ?? 0,
      updatedAt,
    } satisfies AgentSubagent;
  });

  return children
    .filter((child): child is AgentSubagent => child !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, SUBAGENT_LIST_LIMIT);
}

async function readMeta(file: string): Promise<SubagentMeta> {
  const createdAt = await regularFileMtime(file);
  // No sidecar at all is normal for a child spawned without one.
  if (createdAt === null) return EMPTY_META;
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(META_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, META_MAX_BYTES, 0);
      return parseSubagentMeta(buffer.subarray(0, bytesRead).toString("utf8"), createdAt);
    } finally {
      await handle.close();
    }
  } catch {
    return { ...EMPTY_META, createdAt };
  }
}

/** What the reference cache holds: its entry count, and a byte estimate of the parsed records it keeps. */
export function referenceCacheStats(): { entries: number; approxBytes: number } {
  let approxBytes = 0;
  for (const [key, probe] of probeCache) {
    approxBytes +=
      2 * (key.length + probe.fingerprint.length) +
      2 * JSON.stringify(probe.first ?? null).length +
      2 * JSON.stringify(probe.last ?? null).length;
  }
  return { entries: probeCache.size, approxBytes };
}
