import { lstat, open, readdir, realpath } from "fs/promises";
import os from "os";
import path from "path";
import { LAUNCH_GREETINGS } from "../../shared/config/helpAssistantGreeting.js";
import {
  HELP_PAST_SESSIONS_LIMIT,
  type HelpPastSession,
  type HelpPastSessionsListing,
} from "../../shared/types/ipc/help.js";
import type { CodexFolderSessionsResult } from "../../shared/types/ipc/agentSubagents.js";

/**
 * Past assistant conversations for one project (#13206).
 *
 * Every assistant lane of a project on one agent runs in the same
 * `help-sessions/<hash>` directory (`<hash>.<agent>` for any agent but Claude),
 * so the agents' own transcript stores already hold that project's whole
 * history. This reads them — never writes — and turns each conversation into a
 * picker row. Both stores are uncontracted formats, so every field is
 * optional and a failure degrades to fewer rows rather than an error — but the
 * listing says which store came up short, so fewer never passes for all.
 */

const TITLE_MAX_CHARS = 120;
/**
 * Bytes read from each end of a Claude transcript. A long conversation runs to
 * megabytes, but its first prompt sits in the head and its newest title in the
 * tail; nothing in between changes the row.
 */
const EDGE_BYTES = 64 * 1024;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_SUFFIX = ".jsonl";
/** Transcripts summarised at once — a long history must not open every file together. */
const READ_CONCURRENCY = 8;

/**
 * Claude names a project folder after its cwd with every character that is
 * not ASCII alphanumeric replaced by `-` — the space in `Application Support`
 * included — so a slash-only substitution misses the assistant's transcripts.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * A prompt as a one-line title: the pasted-content wrapper the terminal adds
 * around a paste is dropped, whitespace collapsed, and the first line kept.
 */
export function normalizePromptTitle(raw: string): string {
  const unwrapped = raw.replace(/<\/?pasted_content\b[^>]*>/g, "\n");
  const firstLine =
    unwrapped
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : firstLine;
}

function isGreeting(prompt: string): boolean {
  return LAUNCH_GREETINGS.has(prompt.replace(/\s+/g, " ").trim());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The text of a user entry the human actually typed, or null for everything
 * else Claude files as `user`: tool results (an array carrying `tool_result`
 * blocks), harness-injected meta turns, and anything without text.
 */
function humanPromptText(entry: Record<string, unknown>): string | null {
  if (entry.isMeta === true) return null;
  if (entry.toolUseResult !== undefined) return null;
  const message = asRecord(entry.message);
  const content = message?.content;
  if (typeof content === "string") return nonEmptyString(content);
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "tool_result") return null;
    if (record.type === "text" && typeof record.text === "string") text += record.text;
  }
  return nonEmptyString(text);
}

export interface ClaudeTranscriptSummary {
  title: string;
}

/**
 * Summarise a transcript from its edges. `head` and `tail` may overlap or be
 * the same text for a small file; either may start or end mid-line (a bounded
 * read, or a write still in flight), and such a fragment fails to parse and is
 * skipped like any other malformed line.
 *
 * Returns null for a transcript with no real prompt besides the launch
 * greeting — an assistant that was opened and never asked anything.
 */
export function summarizeClaudeTranscript(
  head: string,
  tail: string,
  /**
   * False when the edges skip part of the file. A real prompt can then sit in
   * the unread middle, so not finding one proves nothing: such a transcript is
   * kept rather than filtered as greeting-only. A launch that was never used
   * is a handful of lines, always read whole.
   */
  complete = true
): ClaudeTranscriptSummary | null {
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;
  let hasRealPrompt = false;

  const visit = (line: string, fromTail: boolean) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let entry: Record<string, unknown> | null;
    try {
      entry = asRecord(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!entry) return;
    switch (entry.type) {
      case "custom-title": {
        const value = nonEmptyString(entry.customTitle) ?? nonEmptyString(entry.title);
        // Lines are visited oldest first, so the last one seen is the newest.
        if (value) customTitle = value;
        return;
      }
      case "ai-title": {
        const value = nonEmptyString(entry.aiTitle) ?? nonEmptyString(entry.title);
        if (value) aiTitle = value;
        return;
      }
      case "last-prompt": {
        const value = nonEmptyString(entry.lastPrompt);
        if (value && !isGreeting(value)) hasRealPrompt = true;
        return;
      }
      case "user": {
        const prompt = humanPromptText(entry);
        if (!prompt || isGreeting(prompt)) return;
        hasRealPrompt = true;
        if (!fromTail && firstPrompt === null) firstPrompt = prompt;
        return;
      }
    }
  };

  for (const line of head.split("\n")) visit(line, false);
  if (tail !== head) for (const line of tail.split("\n")) visit(line, true);

  if (!hasRealPrompt && complete) return null;
  const title = normalizePromptTitle(customTitle ?? aiTitle ?? firstPrompt ?? "");
  return { title: title || "Untitled conversation" };
}

async function readEdges(
  filePath: string
): Promise<{ head: string; tail: string; complete: boolean }> {
  const handle = await open(filePath, "r");
  try {
    // Sized now, not when the folder was listed: the live conversation's
    // transcript grows in between, and its newest title is in the tail.
    const { size } = await handle.stat();
    const readAt = async (position: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    if (size <= EDGE_BYTES * 2) {
      const whole = await readAt(0, size);
      return { head: whole, tail: whole, complete: true };
    }
    const [head, tail] = await Promise.all([
      readAt(0, EDGE_BYTES),
      readAt(size - EDGE_BYTES, EDGE_BYTES),
    ]);
    return { head, tail, complete: false };
  } finally {
    await handle.close();
  }
}

/** The Claude projects root main would expect the assistant to have written to. */
export function defaultClaudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir && path.isAbsolute(configDir)
    ? path.join(configDir, "projects")
    : path.join(os.homedir(), ".claude", "projects");
}

/** Gone, or never there: no history, as opposed to history that couldn't be read. */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export interface ClaudeHelpSessionsRead {
  /** Newest first. */
  sessions: HelpPastSession[];
  /**
   * False when a project folder or transcript that exists couldn't be read.
   * Only transcripts the listing had to open count: one older than every row
   * it keeps is never opened, so it can't fail the listing either.
   */
  complete: boolean;
}

/** Runs `task` over `items` with at most READ_CONCURRENCY in flight. */
async function eachBounded<T>(
  items: readonly T[],
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
}

/** Newest first; equal times by id, the order the merged listing caps in. */
function newerFirst(a: { at: number; id: string }, b: { at: number; id: string }): number {
  return b.at - a.at || a.id.localeCompare(b.id);
}

interface TranscriptFile {
  filePath: string;
  mtimeMs: number;
}

/**
 * One conversation's transcripts, one per spelling of the session path that
 * holds it, in spelling order: the first that summarises is its row.
 */
interface TranscriptGroup {
  sessionId: string;
  files: TranscriptFile[];
  /** The newest of its files' times: no row the group yields is newer. */
  newest: number;
}

export async function listClaudeHelpSessions(
  sessionPath: string,
  projectsRoot: string,
  /**
   * The most rows wanted. Transcripts are opened newest first and only until
   * this many rows are in hand, so a long history costs what the cap does.
   */
  limit = Number.POSITIVE_INFINITY
): Promise<ClaudeHelpSessionsRead> {
  // Claude records the cwd as the process saw it, which may be the resolved
  // spelling of the path main handed it.
  const spellings = new Set([sessionPath]);
  let complete = true;
  try {
    spellings.add(await realpath(sessionPath));
  } catch (error) {
    // A session directory that does not exist yet has no transcripts either;
    // one that can't be resolved may have filed them under the other spelling.
    if (!isAbsent(error)) complete = false;
  }

  const groups = new Map<string, TranscriptGroup>();
  for (const spelling of spellings) {
    const dir = path.join(projectsRoot, claudeProjectSlug(spelling));
    let names: string[];
    try {
      // A symlinked project folder could point at another project's history.
      if (!(await lstat(dir)).isDirectory()) continue;
      names = await readdir(dir);
    } catch (error) {
      if (!isAbsent(error)) complete = false;
      continue;
    }
    const sessionIds = names
      .filter((name) => name.endsWith(TRANSCRIPT_SUFFIX))
      .map((name) => name.slice(0, -TRANSCRIPT_SUFFIX.length))
      .filter((sessionId) => CLAUDE_SESSION_ID.test(sessionId));
    const found: Array<{ sessionId: string; file: TranscriptFile } | undefined> = [];
    await eachBounded(sessionIds, async (sessionId, index) => {
      const filePath = path.join(dir, `${sessionId}${TRANSCRIPT_SUFFIX}`);
      try {
        // lstat: a symlink planted in the store is not a transcript we follow.
        const stats = await lstat(filePath);
        if (!stats.isFile() || stats.size === 0) return;
        found[index] = { sessionId, file: { filePath, mtimeMs: stats.mtimeMs } };
      } catch (error) {
        // Removed mid-scan is one fewer conversation; unreadable is one hidden.
        if (!isAbsent(error)) complete = false;
      }
    });
    for (const entry of found) {
      if (!entry) continue;
      const group = groups.get(entry.sessionId);
      if (group) {
        group.files.push(entry.file);
        group.newest = Math.max(group.newest, entry.file.mtimeMs);
      } else {
        groups.set(entry.sessionId, {
          sessionId: entry.sessionId,
          files: [entry.file],
          newest: entry.file.mtimeMs,
        });
      }
    }
  }

  const summarize = async (group: TranscriptGroup): Promise<HelpPastSession | null> => {
    for (const file of group.files) {
      try {
        const { head, tail, complete: whole } = await readEdges(file.filePath);
        const summary = summarizeClaudeTranscript(head, tail, whole);
        if (!summary) continue;
        return {
          agentId: "claude",
          sessionId: group.sessionId,
          title: summary.title,
          updatedAt: file.mtimeMs,
        };
      } catch (error) {
        if (!isAbsent(error)) complete = false;
      }
    }
    return null;
  };

  // A group's row is never newer than its newest file, so once `limit` rows
  // are in hand and the next group can't outrank the last of them, nothing
  // older can either. Until then, each round opens at most as many groups as
  // rows are still missing.
  const order = [...groups.values()].sort((a, b) =>
    newerFirst({ at: a.newest, id: a.sessionId }, { at: b.newest, id: b.sessionId })
  );
  const rows: HelpPastSession[] = [];
  const rank = (row: HelpPastSession) => ({ at: row.updatedAt, id: row.sessionId });
  let next = 0;
  while (next < order.length) {
    if (rows.length >= limit) {
      const last = rows[limit - 1]!;
      const candidate = order[next]!;
      if (newerFirst({ at: candidate.newest, id: candidate.sessionId }, rank(last)) > 0) break;
    }
    const round = order.slice(
      next,
      next + Math.min(READ_CONCURRENCY, Math.max(1, limit - rows.length))
    );
    next += round.length;
    const found = await Promise.all(round.map(summarize));
    for (const row of found) if (row) rows.push(row);
    rows.sort((a, b) => newerFirst(rank(a), rank(b)));
  }
  return { sessions: rows.slice(0, limit), complete };
}

export function codexHelpSessionsFrom(result: CodexFolderSessionsResult): HelpPastSession[] {
  if (result.status !== "ok") return [];
  const out: HelpPastSession[] = [];
  for (const session of result.sessions) {
    const name = session.name ? normalizePromptTitle(session.name) : "";
    if (!name && !session.preview.trim()) continue;
    // Codex reports only the FIRST message, and a session opened by
    // `help.launchAgent` starts with the greeting however long it ran after.
    // Unlike a Claude transcript there is nothing here to prove it stopped
    // there, so it stays listed, just without the greeting as its name.
    const preview = isGreeting(session.preview) ? "" : normalizePromptTitle(session.preview);
    out.push({
      agentId: "codex",
      sessionId: session.id,
      title: name || preview || "Untitled conversation",
      updatedAt: session.updatedAt,
    });
  }
  return out;
}

export interface ListHelpPastSessionsDeps {
  claudeProjectsRoot: string;
  listCodexSessions: (cwd: string) => Promise<CodexFolderSessionsResult>;
}

/**
 * Where each agent's assistant conversations were started: Claude's one
 * session directory, and every directory Codex has run in — its own, and the
 * project's shared one from before lanes on different agents were split.
 */
export interface HelpPastSessionPaths {
  claude: string;
  codex: readonly string[];
}

/** A directory, or a path that couldn't be inspected and so may be one. */
async function mayBeDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await lstat(dirPath)).isDirectory();
  } catch (error) {
    return !isAbsent(error);
  }
}

interface CodexRead {
  sessions: HelpPastSession[];
  readable: boolean;
  more: boolean;
}

async function readCodexHelpSessions(
  codexPath: string,
  paths: HelpPastSessionPaths,
  deps: ListHelpPastSessionsDeps
): Promise<CodexRead> {
  let result: CodexFolderSessionsResult;
  try {
    result = await deps.listCodexSessions(codexPath);
  } catch {
    return { sessions: [], readable: false, more: false };
  }
  if (result.status === "ok") {
    return { sessions: codexHelpSessionsFrom(result), readable: true, more: result.more === true };
  }
  if (result.reason !== "cli-missing") return { sessions: [], readable: false, more: false };
  // No CLI is no history for a project that never ran Codex, which is most of
  // them. Only Codex's own session directory says it ran here: the shared one
  // from before the split is Claude's now, and exists for every Claude user.
  const ranHere = codexPath !== paths.claude && (await mayBeDirectory(codexPath));
  return { sessions: [], readable: !ranHere, more: false };
}

/** Narrows a listing to what one assistant may reopen (#18169). */
export interface ListHelpPastSessionsOptions {
  /** Only this agent's store is read, so the other's rows never take the cap. */
  agentId?: HelpPastSession["agentId"];
  /** Conversations left out before the cap, by id: ones an assistant already holds. */
  exclude?: ReadonlySet<string>;
}

const NO_SESSIONS = { sessions: [] as HelpPastSession[] };

/** Newest first, capped. Each store fails on its own without hiding the other. */
export async function listHelpPastSessions(
  paths: HelpPastSessionPaths,
  deps: ListHelpPastSessionsDeps,
  options: ListHelpPastSessionsOptions = {}
): Promise<HelpPastSessionsListing> {
  const exclude = new Set([...(options.exclude ?? [])].map((id) => id.toLowerCase()));
  const kept = (session: HelpPastSession) => !exclude.has(session.sessionId.toLowerCase());
  const readsClaude = options.agentId === undefined || options.agentId === "claude";
  const readsCodex = options.agentId === undefined || options.agentId === "codex";
  const [claude, ...codexByPath] = await Promise.all([
    // One row past the cap, and room for the rows left out: enough to know the
    // merged list is cut without opening a transcript that can't be shown.
    readsClaude
      ? listClaudeHelpSessions(
          paths.claude,
          deps.claudeProjectsRoot,
          HELP_PAST_SESSIONS_LIMIT + 1 + exclude.size
        ).catch((): ClaudeHelpSessionsRead => ({ sessions: [], complete: false }))
      : { ...NO_SESSIONS, complete: true },
    ...(readsCodex ? paths.codex : []).map((codexPath) =>
      readCodexHelpSessions(codexPath, paths, deps)
    ),
  ]);
  // A conversation resumed into the newer directory can be reported under both.
  const codex = new Map<string, HelpPastSession>();
  for (const session of codexByPath.flatMap((read) => read.sessions)) {
    const seen = codex.get(session.sessionId);
    if (!seen || session.updatedAt > seen.updatedAt) codex.set(session.sessionId, session);
  }
  const merged = [...claude.sessions, ...codex.values()].filter(kept);
  const unreadable: HelpPastSessionsListing["unreadable"] = [];
  if (!claude.complete) unreadable.push("claude");
  if (codexByPath.some((read) => !read.readable)) unreadable.push("codex");
  return {
    sessions: merged
      // Ties break on identity so the order — and what the cap keeps — is stable.
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          a.agentId.localeCompare(b.agentId) ||
          a.sessionId.localeCompare(b.sessionId)
      )
      .slice(0, HELP_PAST_SESSIONS_LIMIT),
    unreadable,
    // Codex hands back one page, so older threads past it are cut there.
    truncated: merged.length > HELP_PAST_SESSIONS_LIMIT || codexByPath.some((read) => read.more),
  };
}
