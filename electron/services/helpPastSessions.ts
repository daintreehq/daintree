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
  filePath: string,
  size: number
): Promise<{ head: string; tail: string; complete: boolean }> {
  const handle = await open(filePath, "r");
  try {
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
  sessions: HelpPastSession[];
  /** False when a project folder or transcript that exists couldn't be read. */
  complete: boolean;
}

export async function listClaudeHelpSessions(
  sessionPath: string,
  projectsRoot: string
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

  const sessions = new Map<string, HelpPastSession>();
  const summarizeInto = async (dir: string, name: string): Promise<void> => {
    if (!name.endsWith(TRANSCRIPT_SUFFIX)) return;
    const sessionId = name.slice(0, -TRANSCRIPT_SUFFIX.length);
    if (!CLAUDE_SESSION_ID.test(sessionId) || sessions.has(sessionId)) return;
    const filePath = path.join(dir, name);
    try {
      // lstat: a symlink planted in the store is not a transcript we follow.
      const stats = await lstat(filePath);
      if (!stats.isFile() || stats.size === 0) return;
      const { head, tail, complete } = await readEdges(filePath, stats.size);
      const summary = summarizeClaudeTranscript(head, tail, complete);
      if (!summary) return;
      sessions.set(sessionId, {
        agentId: "claude",
        sessionId,
        title: summary.title,
        updatedAt: stats.mtimeMs,
      });
    } catch (error) {
      // Removed mid-scan is one fewer conversation; unreadable is one hidden.
      if (!isAbsent(error)) complete = false;
    }
  };

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
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let name = names[next++]; name !== undefined; name = names[next++]) {
        await summarizeInto(dir, name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, names.length) }, worker));
  }
  return { sessions: [...sessions.values()], complete };
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

/** Newest first, capped. Each store fails on its own without hiding the other. */
export async function listHelpPastSessions(
  paths: HelpPastSessionPaths,
  deps: ListHelpPastSessionsDeps
): Promise<HelpPastSessionsListing> {
  const [claude, ...codexByPath] = await Promise.all([
    listClaudeHelpSessions(paths.claude, deps.claudeProjectsRoot).catch(
      (): ClaudeHelpSessionsRead => ({ sessions: [], complete: false })
    ),
    ...paths.codex.map((codexPath) => readCodexHelpSessions(codexPath, paths, deps)),
  ]);
  // A conversation resumed into the newer directory can be reported under both.
  const codex = new Map<string, HelpPastSession>();
  for (const session of codexByPath.flatMap((read) => read.sessions)) {
    const seen = codex.get(session.sessionId);
    if (!seen || session.updatedAt > seen.updatedAt) codex.set(session.sessionId, session);
  }
  const merged = [...claude.sessions, ...codex.values()];
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
