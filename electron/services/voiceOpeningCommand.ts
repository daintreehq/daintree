import type { FileHandle } from "fs/promises";
import { promises as fs } from "fs";
import * as path from "path";
import { load as parseYaml } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import type { VoiceCommandEntry } from "../../shared/utils/voiceAgentCommands.js";
import { holdsCredential, isSecretShaped } from "./voiceKeytermSecrets.js";
import { TimeoutError, withTimeout } from "../utils/withTimeout.js";

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
// Text past a cut is screened too, so a credential the cut runs through still counts.
const SCREEN_MARGIN_CHARS = 256;
// A cleanup waits no longer than this for a skill's file; a dead mount
// leaves it its listing.
const READ_BUDGET_MS = 200;

interface CommandFileText {
  description?: string;
  argumentHint?: string;
  body?: string;
}

// One read per file at a time, so a file on a dead mount holds one fs worker
// however many cleanups ask for it. Released when it settles or times out.
const inFlightReads = new Map<string, Promise<string | null>>();

function releaseRead(filePath: string, read: Promise<string | null>): void {
  if (inFlightReads.get(filePath) === read) inFlightReads.delete(filePath);
}

function readPrefixOnce(filePath: string): Promise<string | null> {
  const pending = inFlightReads.get(filePath);
  if (pending) return pending;
  const started = readPrefix(filePath).finally(() => releaseRead(filePath, started));
  inFlightReads.set(filePath, started);
  return started;
}

async function readPrefix(filePath: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
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
  const pending = readPrefixOnce(filePath);
  try {
    return await withTimeout(pending, READ_BUDGET_MS, "Timed out reading a command file");
  } catch (error) {
    // A read that timed out may never settle, so nothing else would clear it.
    if (error instanceof TimeoutError) releaseRead(filePath, pending);
    return null;
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

// Claude Code commands and every agent's SKILL.md: YAML frontmatter, then the
// text the agent reads. A file without frontmatter is all body; one whose
// frontmatter the read cut off gives nothing.
function markdownCommand(text: string): CommandFileText {
  if (!text.startsWith("---")) return { body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  let record: Record<string, unknown> | null;
  try {
    record = asRecord(parseYaml(text.slice(3, end)));
  } catch {
    record = null;
  }
  const bodyStart = text.indexOf("\n", end + 4);
  return {
    ...(record
      ? {
          description: stringField(record, "description"),
          argumentHint: stringField(record, "argument-hint", "argument_hint"),
        }
      : {}),
    body: bodyStart === -1 ? "" : text.slice(bodyStart + 1),
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

// The same screen the command list passes, on the text either side of the cut.
function screenedClip(text: string, max: number): string | undefined {
  if (!text || holdsCredential(text.slice(0, max + SCREEN_MARGIN_CHARS))) return undefined;
  return clip(text, max);
}

function oneLine(text: string | undefined, max: number): string | undefined {
  return screenedClip(text?.replace(/\s+/g, " ").trim() ?? "", max);
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
