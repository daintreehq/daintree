import type { FileHandle } from "fs/promises";
import { constants as fsConstants, promises as fs } from "fs";
import * as path from "path";
import { load as parseYaml } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import type { VoiceCommandEntry } from "../../shared/utils/voiceAgentCommands.js";
import { holdsCredential, isSecretShaped } from "./voiceKeytermSecrets.js";
import { timeoutSignal } from "../utils/withTimeout.js";

/**
 * What cleanup is shown about the one command a prompt opens with, beyond its
 * line in the list: what follows it is that command's arguments. File content,
 * so never logged.
 */
export interface VoiceOpeningCommand {
  token: string;
  description?: string;
  argumentHint?: string;
  /** The start of the command's own text, as the agent reads it. */
  excerpt?: string;
}

// A skill's frontmatter and the start of its body fit well inside this; the
// rest is never read.
const MAX_READ_BYTES = 32 * 1024;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_ARGUMENT_HINT_CHARS = 200;
const MAX_EXCERPT_CHARS = 2_000;
const SCREEN_MARGIN_CHARS = 256;
// A cleanup waits no longer than this for a skill's file; a dead mount
// leaves it its listing.
const READ_BUDGET_MS = 200;
// Reads of different files at once, so skills on a dead mount can't take the
// whole fs pool between them. Another waits its turn within its budget; a
// normal read settles in well under a millisecond.
const MAX_PENDING_READS = 2;

interface CommandFileText {
  description?: string;
  argumentHint?: string;
  body?: string;
}

// One read per file at a time, so a file on a dead mount holds one fs worker
// however many cleanups ask for it. A timed-out read stays here until it
// settles, unlike `probeOnce`'s: a timeout can't cancel the syscall, and a
// path pinned to it costs only the excerpt, where a new read per cleanup could
// take every worker in the pool.
const inFlightReads = new Map<string, Promise<string | null>>();

async function readPrefixOnce(filePath: string, budget: AbortSignal): Promise<string | null> {
  for (;;) {
    const pending = inFlightReads.get(filePath);
    if (pending) return pending;
    if (inFlightReads.size < MAX_PENDING_READS) break;
    if (budget.aborted) return null;
    // The caller's budget races too, so a waiter behind reads that never settle
    // ends with its caller rather than staying suspended.
    let onExpired!: () => void;
    const expired = new Promise<void>((resolve) => {
      onExpired = () => resolve();
      budget.addEventListener("abort", onExpired, { once: true });
    });
    await Promise.race([...inFlightReads.values(), expired]);
    budget.removeEventListener("abort", onExpired);
    // A turn that comes after the caller gave up starts no read: none would wait
    // for it. The caller's own signal says so, not a clock its timer doesn't read.
    if (budget.aborted) return null;
  }
  const started = readPrefix(filePath).finally(() => {
    if (inFlightReads.get(filePath) === started) inFlightReads.delete(filePath);
  });
  inFlightReads.set(filePath, started);
  return started;
}

// Non-blocking, so a FIFO put where the skill was opens at once and is turned
// away rather than waiting for a writer. Windows has no such flag, nor FIFOs.
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

async function readPrefix(filePath: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, OPEN_FLAGS);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readWithinBudget(filePath: string): Promise<string | null> {
  const budget = timeoutSignal(READ_BUDGET_MS);
  const gaveUp = new Promise<null>((resolve) =>
    budget.signal.addEventListener("abort", () => resolve(null), { once: true })
  );
  try {
    return await Promise.race([readPrefixOnce(filePath, budget.signal), gaveUp]);
  } catch {
    return null;
  } finally {
    budget.dispose();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

// A fence is a line of exactly three dashes: `----` is a rule and `---x:` a key.
// Lines end at a line feed alone, as YAML's do: a JavaScript `m` anchor would
// also end one at U+2028 inside a quoted value.
const OPENING_FENCE_RE = /^---[ \t]*\n/;
const CLOSING_FENCE_RE = /(?:^|\n)---[ \t]*(?:\n|$)/;

// Claude Code commands and every agent's SKILL.md: YAML frontmatter, then the
// text the agent reads. A file without frontmatter is all body; one whose
// frontmatter the read cut off gives nothing.
function markdownCommand(text: string): CommandFileText {
  const opening = text.match(OPENING_FENCE_RE);
  if (!opening) return { body: text };
  const rest = text.slice(opening[0].length);
  const closing = CLOSING_FENCE_RE.exec(rest);
  if (!closing) return {};
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(parseYaml(rest.slice(0, closing.index)));
  } catch {
    record = null;
  }
  return {
    ...(record
      ? {
          description: stringField(record, "description"),
          argumentHint: stringField(record, "argument-hint", "argument_hint"),
        }
      : {}),
    body: rest.slice(closing.index + closing[0].length),
  };
}

// Gemini commands: TOML whose `prompt` is the text the agent reads.
function tomlCommand(text: string): CommandFileText {
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(parseToml(text));
  } catch {
    return {};
  }
  if (!record) return {};
  return { description: stringField(record, "description"), body: stringField(record, "prompt") };
}

// Codex plugins: a manifest that describes the plugin and holds no text of its own.
function manifestCommand(text: string): CommandFileText {
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(JSON.parse(text));
  } catch {
    return {};
  }
  if (!record) return {};
  const iface = asRecord(record.interface) ?? {};
  return {
    description:
      stringField(iface, "longDescription") ??
      stringField(record, "description") ??
      stringField(iface, "shortDescription"),
  };
}

function parseCommandFile(filePath: string, text: string): CommandFileText {
  switch (path.extname(filePath).toLowerCase()) {
    case ".md":
      return markdownCommand(text);
    case ".toml":
      return tomlCommand(text);
    case ".json":
      return manifestCommand(text);
    default:
      return {};
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// The command list's screen, strict as for any text sent on as written, and on
// each line too: `password:` ending one line holds its value on the next, and
// a `.netrc` line counts only at the start of one.
function holdsAnyCredential(text: string): boolean {
  return (
    holdsCredential(text, true) ||
    text.split(/[\n\u2028\u2029]/).some((line) => holdsCredential(line, true))
  );
}

// Screened either side of the cut, so a credential the cut runs through still counts.
function screenedClip(text: string, max: number): string | undefined {
  if (!text || holdsAnyCredential(text.slice(0, max + SCREEN_MARGIN_CHARS))) return undefined;
  return clip(text, max);
}

// Screened before its lines are joined, which hides where each starts, and
// after, which can put a flag and its value side by side.
function oneLine(text: string | undefined, max: number): string | undefined {
  if (!text || holdsAnyCredential(text)) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat && !holdsCredential(flat, true) ? clip(flat, max) : undefined;
}

function excerptOf(body: string | undefined): string | undefined {
  const text =
    body
      ?.split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() ?? "";
  return screenedClip(text, MAX_EXCERPT_CHARS);
}

/**
 * What cleanup is shown about the command a prompt opens with, `token`, when
 * the target lists it: its full description, its argument hint and the start
 * of its text, read from the file discovery found it in. A built-in has no
 * file, so it has only its description, and so does one whose file can't be
 * read in time. Undefined for a token the target doesn't list, or whose name
 * is secret-shaped; any part holding a credential is left out.
 */
export async function readVoiceOpeningCommand(
  entries: readonly VoiceCommandEntry[],
  token: string | undefined
): Promise<VoiceOpeningCommand | undefined> {
  const entry = token ? entries.find((candidate) => candidate.token === token) : undefined;
  if (!entry || isSecretShaped(entry.token.slice(entry.prefix.length))) return undefined;
  const text = entry.sourcePath ? await readWithinBudget(entry.sourcePath) : null;
  const file = entry.sourcePath && text !== null ? parseCommandFile(entry.sourcePath, text) : {};
  const description = oneLine(file.description ?? entry.description, MAX_DESCRIPTION_CHARS);
  const argumentHint = oneLine(file.argumentHint, MAX_ARGUMENT_HINT_CHARS);
  const excerpt = excerptOf(file.body);
  return {
    token: entry.token,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}
