import { lstat, open, readdir, realpath } from "fs/promises";
import os from "os";
import path from "path";
import { HELP_ASSISTANT_GREETING } from "../../shared/config/helpAssistantGreeting.js";
import type { HelpPastSession } from "../../shared/types/ipc/help.js";
import type { CodexFolderSessionsResult } from "../../shared/types/ipc/agentSubagents.js";

/**
 * Past assistant conversations for one project (#13206).
 *
 * Every assistant lane of a project runs in the same `help-sessions/<hash>`
 * directory, so the agents' own transcript stores already hold that project's
 * whole history. This reads them — never writes — and turns each conversation
 * into a picker row. Both stores are uncontracted formats, so every field is
 * optional and every failure degrades to fewer rows rather than an error.
 */

/** Rows returned at most. Older conversations stay resumable through `/resume`. */
export const HELP_PAST_SESSIONS_LIMIT = 50;
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
  return prompt.replace(/\s+/g, " ").trim() === HELP_ASSISTANT_GREETING;
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

export async function listClaudeHelpSessions(
  sessionPath: string,
  projectsRoot: string
): Promise<HelpPastSession[]> {
  // Claude records the cwd as the process saw it, which may be the resolved
  // spelling of the path main handed it.
  const spellings = new Set([sessionPath]);
  try {
    spellings.add(await realpath(sessionPath));
  } catch {
    // A session directory that does not exist yet has no transcripts either.
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
    } catch {
      // Removed or unreadable mid-scan: one fewer row.
    }
  };

  for (const spelling of spellings) {
    const dir = path.join(projectsRoot, claudeProjectSlug(spelling));
    let names: string[];
    try {
      // A symlinked project folder could point at another project's history.
      if (!(await lstat(dir)).isDirectory()) continue;
      names = await readdir(dir);
    } catch {
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
  return [...sessions.values()];
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

/** Newest first, capped. Each store fails on its own without hiding the other. */
export async function listHelpPastSessions(
  sessionPath: string,
  deps: ListHelpPastSessionsDeps
): Promise<HelpPastSession[]> {
  const [claude, codex] = await Promise.all([
    listClaudeHelpSessions(sessionPath, deps.claudeProjectsRoot).catch(() => []),
    deps
      .listCodexSessions(sessionPath)
      .then(codexHelpSessionsFrom)
      .catch(() => []),
  ]);
  return (
    [...claude, ...codex]
      // Ties break on identity so the order — and what the cap keeps — is stable.
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          a.agentId.localeCompare(b.agentId) ||
          a.sessionId.localeCompare(b.sessionId)
      )
      .slice(0, HELP_PAST_SESSIONS_LIMIT)
  );
}
