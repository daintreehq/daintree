/**
 * Reads the last message a Claude Code session wrote to its own transcript
 * (#12479), out of the file Claude Code already keeps.
 *
 * The same narrow side of the #4100/#11949 boundary `ClaudeSubagentReader`
 * sits on: one file is opened for reading and closed, and nothing under the
 * config dir is written, moved or kept. It reuses that module's id and
 * containment checks and its text-block allowlist, and deliberately none of its
 * reads — its probe looks only at the newest line, and its full read starts at
 * byte zero and keeps the oldest 8 MiB, which is the wrong end for "last".
 *
 * ```
 * <projectsRoot>/<cwd-slug>/<sessionId>.jsonl
 * ```
 *
 * Claude Code writes one content block per record, and the blocks of one API
 * message share its `message.id`. None of it is contracted, so every field is
 * parsed as optional and a line that won't parse costs that line.
 */

import { constants as fsConstants, type Stats } from "fs";
import { lstat, open, readdir, realpath, type FileHandle } from "fs/promises";
import path from "path";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  LAST_MESSAGE_TEXT_MAX_BYTES,
  LAST_MESSAGE_TOOL_INPUT_MAX_BYTES,
  LAST_MESSAGE_TOOL_INPUTS_TOTAL_MAX_BYTES,
  LAST_MESSAGE_TOOL_USE_LIMIT,
  type AgentLastMessageOk,
  type AgentLastMessageResult,
  type AgentLastMessageUnavailableReason,
  type AgentUnansweredToolUse,
} from "../../../shared/types/agentLastMessage.js";
import {
  deriveProjectSlug,
  isContainedDirectory,
  isSafeSessionId,
  recordText,
} from "./ClaudeSubagentReader.js";

/** Bytes read per step back from the end of the file. */
const CHUNK_BYTES = 256 * 1024;
/**
 * Bytes read in total before giving up. A tool result can carry a whole file
 * on one line, so this bounds the read rather than the line count.
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Cap on any id, name or stop reason lifted out of a record. */
const FIELD_MAX_CHARS = 256;

/** Injection seams for tests: the step and the ceiling, nothing else. */
export interface ClaudeSessionReaderOptions {
  signal?: AbortSignal;
  chunkBytes?: number;
  maxScanBytes?: number;
}

/** Where the transcript is. Every field comes from the host, never the caller. */
export interface ClaudeSessionLocation {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
}

function unavailable(reason: AgentLastMessageUnavailableReason): AgentLastMessageResult {
  return { status: "unavailable", reason };
}

function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isAbsence(error)) return null;
    throw error;
  }
}

/**
 * The transcript's path, or null when Claude Code never wrote one.
 *
 * The derived slug is one `lstat`; a miss falls back to finding this exact
 * session id under any project directory, which is the part worth trusting —
 * Daintree minted the id at launch. A name found here is only a candidate: the
 * open below decides whether it is a file this reader will trust.
 */
async function findTranscript(
  location: ClaudeSessionLocation,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const { projectsRoot, cwd, sessionId } = location;
  let rootReal: string;
  try {
    rootReal = await realpath(projectsRoot);
  } catch (error) {
    if (isAbsence(error)) return null;
    throw error;
  }
  const name = `${sessionId}.jsonl`;

  const direct = path.join(projectsRoot, deriveProjectSlug(cwd));
  if (
    (await lstatOrNull(path.join(direct, name))) &&
    (await isContainedDirectory(direct, rootReal))
  ) {
    return path.join(direct, name);
  }

  let entries: string[];
  try {
    entries = await readdir(projectsRoot);
  } catch (error) {
    if (isAbsence(error)) return null;
    throw error;
  }
  // One directory that refuses to be read does not stop the search, but it
  // does stop a miss from meaning the file is not there.
  let failure: unknown;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry === "." || entry === ".." || entry.includes(path.sep)) continue;
    const dir = path.join(projectsRoot, entry);
    try {
      if (!(await lstatOrNull(path.join(dir, name)))) continue;
    } catch (error) {
      failure ??= error;
      continue;
    }
    if (await isContainedDirectory(dir, rootReal)) return path.join(dir, name);
  }
  if (failure !== undefined) throw failure;
  return null;
}

/**
 * Open the transcript through one verified descriptor, or return null when it
 * is not a regular file.
 *
 * `lstat` refuses a symlink planted where the transcript should be, which
 * `stat` would follow to some other session's file. The descriptor is then
 * checked against what was `lstat`ed, so a swap between the check and the open
 * reads nothing, and every byte after that comes from this handle.
 */
async function openVerified(file: string): Promise<{ handle: FileHandle; stats: Stats } | null> {
  const checked = await lstat(file);
  if (!checked.isFile()) return null;
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (stats.isFile() && stats.ino === checked.ino && stats.dev === checked.dev) {
      return { handle, stats };
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    // The file shrank under the read. Claude Code only appends, so this is a
    // rewrite nobody can account for, and the bytes already read may not
    // belong to the file that is there now.
    if (bytesRead === 0) throw new Error("Transcript shrank while it was being read");
    offset += bytesRead;
  }
}

interface ScanState {
  /** The last line had no newline yet — something was mid-write. */
  partialTail: boolean;
  capReached: boolean;
}

/**
 * Complete lines, newest first, as raw bytes.
 *
 * Nothing is decoded until a whole line has been assembled, so a multi-byte
 * character split across two reads is never cut in half. Pieces of a line whose
 * start has not been reached yet are kept apart and joined once, rather than
 * re-concatenated on every step back through a long one.
 */
async function* linesFromEnd(
  handle: FileHandle,
  size: number,
  state: ScanState,
  options: { chunkBytes: number; maxScanBytes: number; signal?: AbortSignal }
): AsyncGenerator<Buffer> {
  let position = size;
  let scanned = 0;
  let pending: Buffer[] = [];
  let atTail = true;

  const emit = (line: Buffer): Buffer | null => {
    if (!atTail) return line;
    atTail = false;
    if (line.length > 0) state.partialTail = true;
    return null;
  };

  while (position > 0) {
    options.signal?.throwIfAborted();
    if (scanned >= options.maxScanBytes) {
      state.capReached = true;
      return;
    }
    const length = Math.min(options.chunkBytes, position, options.maxScanBytes - scanned);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    await readFully(handle, chunk, position);
    scanned += length;

    let end = chunk.length;
    let newline = chunk.lastIndexOf(0x0a, end - 1);
    if (newline === -1) {
      pending.unshift(chunk);
      continue;
    }
    while (newline !== -1) {
      const head = chunk.subarray(newline + 1, end);
      const line = emit(pending.length > 0 ? Buffer.concat([head, ...pending]) : head);
      pending = [];
      if (line) yield line;
      end = newline;
      newline = end > 0 ? chunk.lastIndexOf(0x0a, end - 1) : -1;
    }
    if (end > 0) pending = [chunk.subarray(0, end)];
  }

  const first = emit(Buffer.concat(pending));
  if (first) yield first;
}

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

interface SessionRecord {
  type: string | null;
  subtype: string | null;
  isSidechain: boolean;
  /** Harness-injected, compaction summaries included — nothing anyone said. */
  isMeta: boolean;
  timestamp: number | null;
  message: { content?: unknown } | null;
  messageId: string | null;
  stopReason: string | null;
  toolUses: ToolUse[];
  toolResultIds: string[];
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, FIELD_MAX_CHARS) : null;
}

/**
 * The subagent parser drops everything this one needs — the message id, the
 * sidechain and meta flags, and both halves of every tool call — so it is a
 * parser of its own rather than a widened copy of that one.
 */
export function parseSessionRecord(line: string): SessionRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const rawMessage = record.message;
  const message =
    rawMessage && typeof rawMessage === "object" && !Array.isArray(rawMessage)
      ? (rawMessage as Record<string, unknown>)
      : null;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;

  const toolUses: ToolUse[] = [];
  const toolResultIds: string[] = [];
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const entry = block as Record<string, unknown>;
      if (entry.type === "tool_use") {
        const id = typeof entry.id === "string" ? entry.id : "";
        const name = boundedString(entry.name);
        // An id past the cap is not one Claude minted, and a truncated one
        // could collide with a real one.
        if (id && id.length <= FIELD_MAX_CHARS && name) {
          toolUses.push({ id, name, input: entry.input });
        }
      } else if (entry.type === "tool_result" && typeof entry.tool_use_id === "string") {
        toolResultIds.push(entry.tool_use_id);
      }
    }
  }

  const messageId = message?.id;
  return {
    type: typeof record.type === "string" ? record.type : null,
    subtype: typeof record.subtype === "string" ? record.subtype : null,
    isSidechain: record.isSidechain === true,
    isMeta: record.isMeta === true || record.isCompactSummary === true,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    message: message ? { content } : null,
    messageId:
      typeof messageId === "string" && messageId.length > 0 && messageId.length <= FIELD_MAX_CHARS
        ? messageId
        : null,
    stopReason: boundedString(message?.stop_reason),
    toolUses,
    toolResultIds,
  };
}

/** What one code point costs once `JSON.stringify` has escaped it, in UTF-8 bytes. */
function jsonEscapedBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20) {
    return codePoint === 0x08 ||
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0c ||
      codePoint === 0x0d
      ? 2
      : 6;
  }
  // A lone surrogate is written as a `\uXXXX` escape.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The longest suffix of `text` whose JSON-escaped form fits in `maxBytes`,
 * cut on a code point.
 *
 * Measured escaped rather than raw because the escaped form is what the
 * response cap sees: a control character is one byte of text and six on the
 * wire, and terminal-flavoured text carries plenty of them.
 */
export function tailWithinJsonBytes(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    let index = start - 1;
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xdc00 && codePoint <= 0xdfff && index > 0) {
      const high = text.charCodeAt(index - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        index -= 1;
        codePoint = text.codePointAt(index) ?? codePoint;
      }
    }
    const cost = jsonEscapedBytes(codePoint);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    start = index;
  }
  return start === 0 ? { text, truncated: false } : { text: text.slice(start), truncated: true };
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Keep a result inside the response cap, which is measured on the compact
 * JSON the transport sends. Over it, the transport would drop the structured
 * half entirely, so this gives up question inputs first and then the head of
 * the text rather than let that happen.
 */
export function fitWithinResponseCap(
  result: AgentLastMessageOk,
  maxBytes: number = MCP_RESPONSE_TEXT_MAX_BYTES
): AgentLastMessageOk {
  if (wireBytes(result) <= maxBytes) return result;
  const bare: AgentLastMessageOk = {
    ...result,
    unansweredToolUses: result.unansweredToolUses.map(({ id, name }) => ({ id, name })),
  };
  const over = wireBytes(bare) - maxBytes;
  if (over <= 0 || !bare.message) return bare;
  const textBytes = wireBytes(bare.message.text) - 2;
  const trimmed = tailWithinJsonBytes(bare.message.text, Math.max(0, textBytes - over));
  return {
    ...bare,
    message: {
      ...bare.message,
      text: trimmed.text,
      truncated: bare.message.truncated || trimmed.truncated,
    },
  };
}

/**
 * Tool input is where file contents live, so only a question to the user
 * keeps its input — the questions and their choices are what a caller needs
 * before it can answer. One that is too large is omitted whole rather than
 * cut: a question with half its options is worse than a name and an id.
 */
function projectToolUses(newestFirst: ToolUse[]): AgentUnansweredToolUse[] {
  let inputBytes = 0;
  const kept = newestFirst.slice(0, LAST_MESSAGE_TOOL_USE_LIMIT).map((use) => {
    const projected: AgentUnansweredToolUse = { id: use.id, name: use.name };
    const input = use.input;
    if (
      use.name !== ASK_USER_QUESTION_TOOL_NAME ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return projected;
    }
    const bytes = wireBytes(input);
    if (
      bytes > LAST_MESSAGE_TOOL_INPUT_MAX_BYTES ||
      inputBytes + bytes > LAST_MESSAGE_TOOL_INPUTS_TOTAL_MAX_BYTES
    ) {
      return projected;
    }
    inputBytes += bytes;
    return { ...projected, input: input as Record<string, unknown> };
  });
  return kept.reverse();
}

interface FoundMessage {
  id: string | null;
  /** Newest first, as they were read. */
  texts: string[];
  recordedAt: number | null;
  stopReason: string | null;
  /** Its first record was reached, so no block of it lies beyond the read. */
  complete: boolean;
}

/**
 * The last main-chain assistant message with text, plus the tool uses nothing
 * has answered since.
 *
 * "Last message" is one `message.id`, not the whole turn: prose, then tools,
 * then a final hand-off would otherwise blend an earlier intention into the
 * answer. The records sharing that id are gathered back to the first one, and
 * their text blocks are returned in order.
 *
 * Anything after the reply that is not conversation — hook summaries, turn
 * timings, snapshots — is stepped over rather than mistaken for the end. A
 * reply is never looked for past the read's ceiling: if the ceiling comes
 * first, the answer is that it could not be found, not whatever older reply
 * happened to be within reach.
 */
export async function readClaudeLastMessage(
  location: ClaudeSessionLocation,
  options: ClaudeSessionReaderOptions = {}
): Promise<AgentLastMessageResult> {
  const { signal } = options;
  if (!isSafeSessionId(location.sessionId)) return unavailable("no-session");

  let handle: FileHandle | null = null;
  try {
    signal?.throwIfAborted();
    const file = await findTranscript(location, signal);
    // Claude Code writes the file with the first message, so a session nobody
    // has typed into has nothing on record yet.
    if (!file) return unavailable("no-message");
    const opened = await openVerified(file);
    if (!opened) return unavailable("store-unreadable");
    handle = opened.handle;
    const { stats } = opened;

    const state: ScanState = { partialTail: false, capReached: false };
    const answered = new Set<string>();
    const seenToolUses = new Set<string>();
    const unanswered: ToolUse[] = [];
    let found: FoundMessage | null = null;
    // What was read before the reply was found, and so is newer than it. The
    // assistant ids are kept rather than counted because the reply's own later
    // blocks — a question after its prose — are read first and are not newer
    // than the message they belong to.
    let promptFollows = false;
    const laterAssistantIds: (string | null)[] = [];

    const collectToolUses = (record: SessionRecord): void => {
      for (const use of record.toolUses) {
        if (answered.has(use.id) || seenToolUses.has(use.id)) continue;
        seenToolUses.add(use.id);
        unanswered.push(use);
      }
    };

    for await (const bytes of linesFromEnd(handle, stats.size, state, {
      chunkBytes: options.chunkBytes ?? CHUNK_BYTES,
      maxScanBytes: options.maxScanBytes ?? MAX_SCAN_BYTES,
      signal,
    })) {
      const record = parseSessionRecord(bytes.toString("utf8"));
      if (!record || record.isSidechain) continue;

      if (record.type === "user") {
        for (const id of record.toolResultIds) answered.add(id);
        if (record.isMeta || record.toolResultIds.length > 0) continue;
        // A prompt older than the reply is where the reply began.
        if (found) {
          found.complete = true;
          break;
        }
        promptFollows = true;
        continue;
      }

      if (found) {
        if (record.type === "system" && record.subtype === "compact_boundary") {
          found.complete = true;
          break;
        }
        if (record.type !== "assistant") continue;
        if (record.messageId === null || record.messageId !== found.id) {
          found.complete = true;
          break;
        }
        collectToolUses(record);
        const text = recordText(record.message);
        if (text) found.texts.push(text);
        continue;
      }

      if (record.type !== "assistant") continue;
      collectToolUses(record);
      const text = recordText(record.message);
      if (!text) {
        laterAssistantIds.push(record.messageId);
        continue;
      }
      found = {
        id: record.messageId,
        texts: [text],
        recordedAt: record.timestamp,
        stopReason: record.stopReason,
        // Without an id nothing else can be told to belong to it.
        complete: record.messageId === null,
      };
      if (found.complete) break;
    }

    if (!found) {
      if (state.capReached) return unavailable("search-cap-reached");
      if (unanswered.length === 0) return unavailable("no-message");
    }

    let message: AgentLastMessageOk["message"] = null;
    if (found) {
      const tail = tailWithinJsonBytes(found.texts.reverse().join("\n\n"), LAST_MESSAGE_TEXT_MAX_BYTES);
      message = {
        id: found.id,
        text: tail.text,
        // Blocks of this message may sit beyond the ceiling, which is a cut
        // head just as surely as the byte cap is.
        truncated: tail.truncated || (!found.complete && state.capReached),
        recordedAt: found.recordedAt,
        stopReason: found.stopReason,
      };
    }

    return fitWithinResponseCap({
      status: "ok",
      provider: "claude",
      message,
      unansweredToolUses: projectToolUses(unanswered),
      newerRecordsFollow:
        state.partialTail ||
        promptFollows ||
        laterAssistantIds.some((id) => id === null || id !== found?.id),
      fileUpdatedAt: Math.round(stats.mtimeMs),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isAbsence(error)) return unavailable("no-message");
    return unavailable("store-unreadable");
  } finally {
    await handle?.close();
  }
}
