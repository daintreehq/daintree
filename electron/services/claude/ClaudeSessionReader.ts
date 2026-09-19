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
 *
 * A caller can ask for more of one message than the default keeps, page back
 * through it with the cursor each page hands out, or name an earlier message by
 * how many replies back it is (#12496). All of it stays inside the same bounded
 * read; nothing is kept between calls.
 */

import { constants as fsConstants, type Stats } from "fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "fs/promises";
import path from "path";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  LAST_MESSAGE_TEXT_MAX_BYTES,
  LAST_MESSAGE_TOOL_INPUT_MAX_BYTES,
  LAST_MESSAGE_TOOL_INPUTS_TOTAL_MAX_BYTES,
  LAST_MESSAGE_TOOL_USE_LIMIT,
  type AgentLastMessage,
  type AgentLastMessageOk,
  type AgentLastMessageReadOptions,
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
import { cursorMatches, decodeMessageCursor, encodeMessageCursor } from "./ClaudeMessageCursor.js";

/** Bytes read per step back from the end of the file. */
const CHUNK_BYTES = 256 * 1024;
/**
 * Bytes read in total before giving up. A tool result can carry a whole file
 * on one line, so this bounds the read rather than the line count.
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** Cap on any id, name or stop reason lifted out of a record. */
const FIELD_MAX_CHARS = 256;
/**
 * Nesting a returned question input may have. The transport drops a whole
 * structured result past 100 levels, and the envelope spends a few of them
 * before the input starts, so an input past this is omitted rather than
 * allowed to cost the caller everything else.
 */
const TOOL_INPUT_MAX_DEPTH = 32;

/**
 * What the caller asked for, already validated, plus the injection seams for
 * tests: the step and the ceiling, nothing else.
 */
export interface ClaudeSessionReaderOptions extends AgentLastMessageReadOptions {
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
): Promise<{ file: string; rootReal: string } | null> {
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
    return { file: path.join(direct, name), rootReal };
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
    if (await isContainedDirectory(dir, rootReal)) return { file: path.join(dir, name), rootReal };
  }
  if (failure !== undefined) throw failure;
  return null;
}

function isWithin(rootReal: string, target: string): boolean {
  const relative = path.relative(rootReal, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/**
 * Open the transcript through one verified descriptor, or return null when it
 * is not a file this reader will trust.
 *
 * `lstat` refuses a symlink planted where the transcript should be, which
 * `stat` would follow to some other session's file, and the descriptor is then
 * checked against what was `lstat`ed, so a leaf swapped between the two reads
 * nothing. `O_NONBLOCK` keeps a leaf swapped for a FIFO from holding the open
 * until a writer appears; the descriptor check then refuses it. `O_NOFOLLOW`
 * covers the last path component only, though: a project directory swapped for
 * a symlink after the containment check would carry the open outside the
 * store. So once the file is open, its real path must still lie inside the
 * store and still name the file the descriptor holds.
 *
 * That narrows the window rather than closing it — Node has no
 * descriptor-relative open, so a process swapping the directory back and forth
 * around each check can still win. It would gain nothing by it: the store is
 * the user's own, and anything able to race it can already write the
 * transcript that would have been read. Every byte after this comes from the
 * handle.
 */
async function openVerified(
  file: string,
  rootReal: string
): Promise<{ handle: FileHandle; stats: Stats } | null> {
  const checked = await lstat(file);
  if (!checked.isFile()) return null;
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  );
  try {
    const stats = await handle.stat();
    if (stats.isFile() && sameFile(stats, checked)) {
      const real = await realpath(file);
      if (isWithin(rootReal, real) && sameFile(await stat(real), stats)) {
        return { handle, stats };
      }
    }
  } catch {
    // The file was opened and could not then be verified — a name that
    // vanished under the check included. That is not an absent transcript.
  }
  await handle.close();
  return null;
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
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
  /** Harness-injected, compaction summaries included — nothing said to the agent or by it. */
  isMeta: boolean;
  /** Something said to the agent — text or any other non-result block — whatever else the record carries. */
  isPrompt: boolean;
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
function parseSessionRecord(line: string): SessionRecord | null {
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
  // A record can carry a tool result and something the user typed together;
  // the result answers a call, and the rest is still a prompt.
  let isPrompt = typeof content === "string" && content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const entry = block as Record<string, unknown>;
      if (entry.type !== "tool_result" && entry.type !== "tool_use") {
        isPrompt ||=
          entry.type !== "text" || (typeof entry.text === "string" && entry.text.trim().length > 0);
      }
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
    isPrompt,
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
function nestingExceeds(value: unknown, maxDepth: number): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > maxDepth) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

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
    // Depth first: serializing is itself recursive, so on a deep enough input
    // the size check below would be the call that overflows.
    if (nestingExceeds(input, TOOL_INPUT_MAX_DEPTH)) return projected;
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

/** Whether `record`, read after some of `id`'s records, lies before that message began. */
function endsMessage(record: SessionRecord, id: string | null): boolean {
  if (record.type === "user") return !record.isMeta && record.isPrompt;
  if (record.type === "system") return record.subtype === "compact_boundary";
  if (record.type === "assistant") return record.messageId === null || record.messageId !== id;
  return false;
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
 *
 * An earlier message (`messageIndex`) or the one a cursor names is found the
 * same way, by carrying on past each newer message with text, and everything
 * said about the last one then holds for it: its tool uses are the calls made
 * in or after it, and whatever it passed over is newer conversation.
 */
export async function readClaudeLastMessage(
  location: ClaudeSessionLocation,
  options: ClaudeSessionReaderOptions = {}
): Promise<AgentLastMessageResult> {
  const { signal } = options;
  if (!isSafeSessionId(location.sessionId)) return unavailable("no-session");
  const cursor = options.cursor === undefined ? null : decodeMessageCursor(options.cursor);
  if (options.cursor !== undefined && !cursor) return unavailable("message-not-found");
  const index = cursor ? 0 : (options.messageIndex ?? 0);
  const latestWanted = !cursor && index === 0;

  let handle: FileHandle | null = null;
  try {
    signal?.throwIfAborted();
    const transcript = await findTranscript(location, signal);
    // Claude Code writes the file with the first message, so a session nobody
    // has typed into has nothing on record yet.
    if (!transcript) return unavailable(latestWanted ? "no-message" : "message-not-found");
    const opened = await openVerified(transcript.file, transcript.rootReal);
    if (!opened) return unavailable("store-unreadable");
    handle = opened.handle;
    const { stats } = opened;

    const state: ScanState = { partialTail: false, capReached: false };
    const answered = new Set<string>();
    const seenToolUses = new Set<string>();
    const unanswered: ToolUse[] = [];
    let found: FoundMessage | null = null;
    let selected: { message: FoundMessage; text: string } | null = null;
    // Messages with text passed over on the way to the one wanted; each is
    // newer than it.
    let passed = 0;
    // What was read before the reply was found, and so is newer than it: a
    // prompt or a tool result sets the first; the assistant ids are kept rather
    // than counted because the reply's own later blocks — a question after its
    // prose — are read first and are not newer than the message they belong to.
    let userFollows = false;
    const laterAssistantIds: (string | null)[] = [];

    // Newest first, like the scan itself, including within one record.
    const collectToolUses = (record: SessionRecord): void => {
      for (const use of [...record.toolUses].reverse()) {
        if (answered.has(use.id) || seenToolUses.has(use.id)) continue;
        seenToolUses.add(use.id);
        unanswered.push(use);
      }
    };

    const choose = (message: FoundMessage): { message: FoundMessage; text: string } | null => {
      if (!cursor && passed !== index) return null;
      const text = [...message.texts].reverse().join("\n\n");
      return !cursor || cursorMatches(cursor, message.id, text) ? { message, text } : null;
    };

    for await (const bytes of linesFromEnd(handle, stats.size, state, {
      chunkBytes: options.chunkBytes ?? CHUNK_BYTES,
      maxScanBytes: options.maxScanBytes ?? MAX_SCAN_BYTES,
      signal,
    })) {
      const record = parseSessionRecord(bytes.toString("utf8"));
      if (!record || record.isSidechain) continue;
      if (record.type === "assistant" && record.isMeta) continue;
      if (record.type === "user") {
        for (const id of record.toolResultIds) answered.add(id);
      }

      if (found && endsMessage(record, found.id)) {
        found.complete = true;
        selected = choose(found);
        if (selected) break;
        // Not the one wanted, so the record that ended it is read again below
        // as the newest record of whatever came before.
        passed += 1;
        found = null;
      }

      if (found) {
        if (record.type !== "assistant") continue;
        collectToolUses(record);
        const text = recordText(record.message);
        if (text) found.texts.push(text);
        continue;
      }

      if (record.type === "user") {
        // A prompt, or a bare result, read before the reply is activity after
        // its text.
        if (!record.isMeta && (record.isPrompt || record.toolResultIds.length > 0)) {
          userFollows = true;
        }
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
      if (found.complete) {
        selected = choose(found);
        if (selected) break;
        passed += 1;
        found = null;
      }
    }
    // The read ran out partway through a message, at the start of the file or
    // at the ceiling.
    if (found && !selected) selected = choose(found);

    if (!selected) {
      if (state.capReached) return unavailable("search-cap-reached");
      if (!latestWanted) return unavailable("message-not-found");
      if (unanswered.length === 0) return unavailable("no-message");
    }

    let message: AgentLastMessage | null = null;
    // Where the page ends in the message's text: the end of it, or where the
    // previous page began.
    const end = selected ? (cursor?.end ?? selected.text.length) : 0;
    if (selected) {
      const page = tailWithinJsonBytes(
        selected.text.slice(0, end),
        options.maxBytes ?? LAST_MESSAGE_TEXT_MAX_BYTES
      );
      message = {
        id: selected.message.id,
        text: page.text,
        // Blocks of this message may sit beyond the ceiling, which is a cut
        // head just as surely as the byte cap is.
        truncated: page.truncated || (!selected.message.complete && state.capReached),
        recordedAt: selected.message.recordedAt,
        stopReason: selected.message.stopReason,
        // A stand-in no shorter than the real one, which can only be minted
        // once fitting has settled where the page starts.
        nextCursor: encodeMessageCursor(selected.message.id, selected.text, end),
      };
    }

    const fitted = fitWithinResponseCap({
      status: "ok",
      provider: "claude",
      message,
      unansweredToolUses: projectToolUses(unanswered),
      newerRecordsFollow:
        state.partialTail ||
        userFollows ||
        passed > 0 ||
        laterAssistantIds.some((id) => id === null || id !== selected?.message.id),
      fileUpdatedAt: Math.round(stats.mtimeMs),
    });
    if (!selected || !fitted.message) return fitted;
    // The start of the text that survived fitting, not of the page before it:
    // a cursor from the earlier start would skip whatever fitting cut.
    const start = end - fitted.message.text.length;
    return {
      ...fitted,
      message: {
        ...fitted.message,
        nextCursor:
          start > 0 ? encodeMessageCursor(selected.message.id, selected.text, start) : null,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isAbsence(error)) return unavailable(latestWanted ? "no-message" : "message-not-found");
    return unavailable("store-unreadable");
  } finally {
    await handle?.close();
  }
}
