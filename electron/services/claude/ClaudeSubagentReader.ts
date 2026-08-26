/**
 * Reads the child sessions a Claude Code conversation spawned, out of the files
 * Claude Code already wrote.
 *
 * ## The boundary this sits on (#4100, #11949)
 *
 * `shared/config/agents/claude.ts` carries a standing prohibition: Daintree
 * must not touch Claude Code's private per-folder store. That was written about
 * resume and cross-path continuity — about *changing* what Claude Code keeps,
 * or leaning on it to move a conversation between paths. This module does
 * neither. It opens files for reading and closes them. Nothing here writes,
 * renames, deletes, or moves anything under the config dir, and nothing here
 * feeds `AgentStateService`: PTY observation stays the only source of the
 * parent's state, and a child's status is reported as its own, never merged in.
 *
 * The alternatives were the ones that would have crossed the line.
 * `SubagentStart`/`SubagentStop` hooks need entries written into the user's
 * `settings.json`, and `--output-format stream-json` means running Claude
 * headless, already rejected in `docs/architecture/agent-state-tracking-strategy.md`.
 * Reading is what is left, and it is the narrow part of the prohibition.
 *
 * ## What is actually on disk
 *
 * ```
 * <configDir>/projects/<cwd-slug>/<parentSessionId>/subagents/agent-<id>.jsonl
 * <configDir>/projects/<cwd-slug>/<parentSessionId>/subagents/agent-<id>.meta.json
 * ```
 *
 * None of it is contracted. Anthropic documents neither the record schema nor
 * the slug algorithm, so every field is parsed as optional and an unreadable or
 * unrecognised record costs one row rather than the whole list.
 */

import { createReadStream } from "fs";
import { lstat, open, readdir, realpath, stat } from "fs/promises";
import { createInterface } from "readline";
import os from "os";
import path from "path";
import {
  SUBAGENT_LIST_LIMIT,
  SUBAGENT_MESSAGE_MAX_CHARS,
  SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT,
  trimPreservingTask,
  type AgentSubagent,
  type AgentSubagentMessage,
  type AgentSubagentStatus,
} from "../../../shared/types/ipc/agentSubagents.js";

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
/** Lines walked in one full transcript read, so a pathological file still terminates. */
const TRANSCRIPT_MAX_LINES = 50_000;
/**
 * Bytes streamed in one full transcript read. A line cap alone is not a bound:
 * a tool result can carry a whole file on a single line, and `readline` has to
 * hold that line entire before anything gets to skip it.
 */
const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;
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
 * `CLAUDE_CONFIG_DIR` is a real override the CLI honours, and this repo already
 * treats it as one when discovering commands and skills. Never sourced from the
 * renderer — the process environment is the only input.
 *
 * Known limitation: this reads Daintree's own environment, not the terminal's.
 * A project preset or the user's shell can export a different
 * `CLAUDE_CONFIG_DIR` to the agent alone, and that store is invisible here —
 * the list comes back empty rather than wrong. Closing it means recording the
 * effective value on the pty-host terminal record at spawn.
 */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".claude");
}

/**
 * Claude Code keys a project directory off the cwd. Every observed name is the
 * absolute path with the separators replaced by dashes, and literal dashes in a
 * path segment survive untouched.
 *
 * This is a guess with a good hit rate, not a contract — the algorithm is
 * undocumented, and no sampled path exercised a dot, a space, or a Windows
 * drive letter. So it is only ever the fast path: `findSessionDir` verifies the
 * directory exists and falls back to a search keyed on the session id, which is
 * exact. Nothing downstream depends on this being right.
 */
export function deriveProjectSlug(cwd: string): string {
  return cwd.replace(/[\\/]/g, "-");
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

function isSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== "." && value !== "..";
}

/** Child ids appear in a filename, so anything that could steer a path is refused outright. */
export function isSafeSubagentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Locate a session's `subagents/` directory.
 *
 * The derived slug is tried first because it is one `stat`. When it misses —
 * a path shape the slug rule doesn't cover, or a Windows encoding nobody has
 * verified — the projects root is scanned for the directory holding this exact
 * session id. That is the part worth trusting: the id was minted by Daintree at
 * launch, so a directory named after it is this terminal's and no one else's.
 */
export async function findSubagentsDir(
  cwd: string,
  parentSessionId: string,
  options: ClaudeSubagentReaderOptions = {}
): Promise<string | null> {
  if (!isSafeSessionId(parentSessionId)) return null;
  const projectsRoot = path.join(options.configDir ?? resolveClaudeConfigDir(), "projects");
  // Resolved once so a user who symlinks their whole config dir still matches,
  // while a symlink planted *inside* it cannot point the read somewhere else.
  const rootReal = await realpathOrNull(projectsRoot);
  if (!rootReal) return null;

  const direct = path.join(projectsRoot, deriveProjectSlug(cwd), parentSessionId, "subagents");
  if (await isContainedDirectory(direct, rootReal)) return direct;

  let entries: string[];
  try {
    entries = await readdir(projectsRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    // `entry` comes from the filesystem, but it is still joined blind, so a
    // traversal-shaped name is skipped rather than resolved.
    if (entry === "." || entry === ".." || entry.includes(path.sep)) continue;
    const candidate = path.join(projectsRoot, entry, parentSessionId, "subagents");
    if (await isContainedDirectory(candidate, rootReal)) return candidate;
  }
  return null;
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/** True only for a real directory that resolves to somewhere under `rootReal`. */
async function isContainedDirectory(target: string, rootReal: string): Promise<boolean> {
  if (!(await isDirectory(target))) return false;
  const real = await realpathOrNull(target);
  if (!real) return false;
  const relative = path.relative(rootReal, real);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
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

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
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

/** Test-only: the probe cache is module state and outlives any one reader call. */
export function __resetClaudeSubagentProbeCache(): void {
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
    // as long as the probe reached the end of it.
    const firstLine =
      firstBreak === -1
        ? head.bytesRead < LIST_PROBE_BYTES
          ? headText
          : ""
        : headText.slice(0, firstBreak);
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
 * The final record in a chunk, and whether it was whole.
 *
 * Only the newest non-blank line is considered. Walking further back to find
 * something parseable is what would let a child that finished one turn and is
 * midway through writing the next be reported as finished — the older
 * `end_turn` is real, it just isn't this child's last word any more. When the
 * newest line won't parse, that is reported as a partial tail so the caller can
 * fall back to file activity instead of to stale evidence.
 *
 * A chunk that starts mid-file opens on a fragment, so a chunk of one line has
 * no whole record in it at all.
 */
function finalRecord(
  chunk: string,
  fromStart: boolean
): { last: ParsedRecord | null; partialTail: boolean } {
  const lines = chunk.split("\n");
  const floor = fromStart ? 0 : 1;
  for (let index = lines.length - 1; index >= floor; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const record = parseRecord(line);
    return record ? { last: record, partialTail: false } : { last: null, partialTail: true };
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

export interface TranscriptRead {
  messages: AgentSubagentMessage[];
  truncated: boolean;
}

/**
 * Fold a child's whole transcript into the task it was given and what it said
 * back, streamed a line at a time so a large file never lands in memory whole.
 *
 * Bounded three ways: by bytes at the stream, because one tool-result line can
 * carry an entire file and `readline` has to hold it whole before anything gets
 * to skip it; by line count, against a file that is all short records; and by
 * message count on the way out.
 */
export async function readTranscriptFile(file: string): Promise<TranscriptRead> {
  const stream = createReadStream(file, { encoding: "utf8", end: TRANSCRIPT_MAX_BYTES - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const messages: AgentSubagentMessage[] = [];
  let dropped = false;
  let seen = 0;

  try {
    for await (const line of lines) {
      seen += 1;
      if (seen > TRANSCRIPT_MAX_LINES) {
        dropped = true;
        break;
      }
      const record = parseRecord(line);
      if (!record) continue;
      const role = record.type === "user" ? "task" : record.type === "assistant" ? "reply" : null;
      if (!role) continue;
      const text = recordText(record.message);
      if (!text) continue;
      messages.push({ role, text: text.slice(0, SUBAGENT_MESSAGE_MAX_CHARS) });

      if (messages.length > SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT) {
        dropped = true;
        trimPreservingTask(messages, SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  // The byte ceiling cuts the tail off rather than the head, so say so.
  if (stream.bytesRead >= TRANSCRIPT_MAX_BYTES - 1) dropped = true;
  return { messages, truncated: dropped };
}
