/**
 * Whether a Claude Code session id has a conversation behind it, read out of the
 * store Claude Code already keeps (#12371).
 *
 * Daintree assigns Claude's session id at launch (#11782), but Claude Code only
 * writes `<configDir>/projects/<slug>/<id>.jsonl` once a message is sent. A pane
 * nobody typed into leaves an id behind that `--resume` rejects outright ("No
 * conversation found"), and the CLI offers no way to ask beforehand. The file is
 * the only answer, so this reads the store — and only reads it, the same narrow
 * side of the #4100 boundary `ClaudeSubagentReader` sits on.
 *
 * Claude Code writes nothing else keyed by the id before that first message, so
 * absence can only ever be proven in one store at a time. Everything here starts
 * by asking which store that is, and answers `unknown` when it can't be sure:
 * reading the wrong one would call a live conversation missing.
 *
 * Every answer is one observation at one moment and is never kept: the first
 * message can create the transcript right after a `missing`.
 */

import { lstat, readdir } from "fs/promises";
import os from "os";
import path from "path";
import { relaunchResumeAsAssignedSession } from "../../../shared/types/agentSettings.js";
import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";
import {
  getShellObservedEnv,
  type ShellObservedEnv,
} from "../../setup/shellEnvironmentObservation.js";
import { getEnvVar } from "../pty/EnvironmentFilter.js";
import { deriveProjectSlug } from "./ClaudeSubagentReader.js";

/**
 * `unknown` covers everything that isn't proof either way: a store that can't be
 * pinned down or read in full, a lookup that ran out of time, an id that can't be
 * one of Claude's. Callers treat it as "do what you did before".
 */
export type ClaudeTranscriptObservation = "present" | "missing" | "unknown";

/** Budget for one caller's lookup, fallback scan included. A dead mount must not hold up a launch. */
export const CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * How long a store that timed out is left alone. A dead mount answers every
 * lookup the same way, and each one would spend the whole budget again — on app
 * quit, once per pane, against a fixed shutdown deadline.
 */
export const CLAUDE_STORE_UNREACHABLE_COOLDOWN_MS = 60_000;

const CLAUDE_AGENT_ID = "claude";
const CONFIG_DIR_VAR = "CLAUDE_CONFIG_DIR";
const TRANSCRIPT_SUFFIX = ".jsonl";
/** Concurrent project-directory reads during a scan. */
const SCAN_CONCURRENCY = 8;
/** Claude Code only accepts a UUID as a session id, so nothing else can name a transcript it wrote. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The titles a Claude pane carries before its first message: Daintree's label
 * for the agent and Claude Code's idle title, with or without its status glyph.
 * Claude Code retitles the terminal after the conversation it starts.
 */
const UNTOUCHED_TITLE_PATTERN = /^(?:[^\p{L}\p{N}\s]\s*)?Claude(?: Code)?$/u;

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Injection seam for tests. Both are plain `fs/promises` reads. */
export interface ClaudeStoreFs {
  lstat(target: string): Promise<unknown>;
  readdir(target: string): Promise<string[]>;
}

/** Where a pane's store is decided from. Defaults are this process's own. */
export interface ClaudeStoreContext {
  env?: EnvLike;
  readShellEnv?: () => ShellObservedEnv | undefined;
  platform?: NodeJS.Platform;
}

export interface ClaudeStoreOptions extends ClaudeStoreContext {
  timeoutMs?: number;
  fs?: ClaudeStoreFs;
}

const nodeFs: ClaudeStoreFs = {
  lstat: (target) => lstat(target),
  readdir: (target) => readdir(target),
};

const TIMED_OUT = Symbol("timed out");

function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return Promise.resolve(TIMED_OUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function isAbsence(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function readConfigDir(env: EnvLike | undefined): string | undefined {
  return (env && getEnvVar(env, CONFIG_DIR_VAR)?.trim()) || undefined;
}

function projectsRootFor(configDir: string | undefined): string | null {
  if (!configDir) return path.join(os.homedir(), ".claude", "projects");
  // A relative value resolves against the CLI's own cwd, which differs per pane.
  return path.isAbsolute(configDir) ? path.join(configDir, "projects") : null;
}

/**
 * The `projects/` directory a Claude pane launched with `spawnEnv` reads, or
 * null when that can't be pinned to one place.
 *
 * A pane's shell sources the user's profile, and main copies only `PATH` out of
 * the startup shell probe, so a `CLAUDE_CONFIG_DIR` exported from `.zshrc`
 * reaches every pane but never this process. The probe's own observation fills
 * that in; without one, a POSIX pane's store is unknowable. Windows panes don't
 * source a login profile, so what they inherit is what they get. A profile that
 * exports a different value from the one the pane inherits may or may not win,
 * depending on how it is written, so that is unknown too.
 */
export function resolvePaneClaudeProjectsRoot(
  spawnEnv?: EnvLike,
  context: ClaudeStoreContext = {}
): string | null {
  const platform = context.platform ?? process.platform;
  const shellEnv = platform === "win32" ? {} : (context.readShellEnv ?? getShellObservedEnv)();
  if (!shellEnv) return null;
  const inherited = readConfigDir(spawnEnv) ?? readConfigDir(context.env ?? process.env);
  const exported = readConfigDir(shellEnv);
  if (inherited && exported && inherited !== exported) return null;
  return projectsRootFor(exported ?? inherited);
}

const unreachableUntil = new Map<string, number>();

function isCoolingDown(projectsRoot: string): boolean {
  const until = unreachableUntil.get(projectsRoot);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  unreachableUntil.delete(projectsRoot);
  return false;
}

function markUnreachable(projectsRoot: string): void {
  unreachableUntil.set(projectsRoot, Date.now() + CLAUDE_STORE_UNREACHABLE_COOLDOWN_MS);
}

/**
 * Every session id (lowercased) with a transcript anywhere in the store, or null
 * when the store couldn't be read in full.
 *
 * The whole store, not one project directory: the slug is a guess, and an exact
 * `--resume <id>` finds a conversation in any project, so absence only means
 * something once every directory has been checked. A missing `projects/` is an
 * empty store only when the config dir around it exists — Claude Code creates
 * that on first run, and without it this is more likely the wrong place to look.
 */
async function scanTranscriptIds(
  projectsRoot: string,
  fs: ClaudeStoreFs,
  isCancelled: () => boolean
): Promise<Set<string> | null> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(projectsRoot);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") return null;
    try {
      await fs.lstat(path.dirname(projectsRoot));
      return new Set();
    } catch {
      return null;
    }
  }

  const ids = new Set<string>();
  let failed = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!failed && !isCancelled()) {
      const entry = projectDirs[next++];
      if (entry === undefined) return;
      let names: string[];
      try {
        names = await fs.readdir(path.join(projectsRoot, entry));
      } catch (error) {
        // A stray file beside the project directories, or one removed mid-scan.
        if (isAbsence(error)) continue;
        failed = true;
        return;
      }
      for (const name of names) {
        if (name.endsWith(TRANSCRIPT_SUFFIX)) {
          ids.add(name.slice(0, -TRANSCRIPT_SUFFIX.length).toLowerCase());
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, projectDirs.length) }, worker));
  return failed || isCancelled() ? null : ids;
}

const inFlightScans = new Map<string, Promise<Set<string> | null>>();

/**
 * One scan per store at a time, shared by every caller who asks while it runs —
 * a session restore asks for every pane at once — and forgotten the moment it
 * settles. Each caller waits only as long as its own budget allows. The scan
 * stops reading once the budget of the caller that started it runs out, and
 * that store is then left alone for a while; `fs` calls already started can't
 * be recalled.
 */
async function readTranscriptIndex(
  projectsRoot: string,
  fs: ClaudeStoreFs,
  timeoutMs: number
): Promise<Set<string> | null> {
  if (timeoutMs <= 0) return null;
  let scan = inFlightScans.get(projectsRoot);
  if (!scan) {
    let cancelled = false;
    const started = scanTranscriptIds(projectsRoot, fs, () => cancelled).catch(() => null);
    const shared: Promise<Set<string> | null> = within(started, timeoutMs)
      .then((result) => {
        if (result !== TIMED_OUT) return result;
        cancelled = true;
        markUnreachable(projectsRoot);
        return null;
      })
      .finally(() => {
        if (inFlightScans.get(projectsRoot) === shared) inFlightScans.delete(projectsRoot);
      });
    inFlightScans.set(projectsRoot, shared);
    scan = shared;
  }
  const result = await within(scan, timeoutMs);
  return result === TIMED_OUT ? null : result;
}

type DirectLookup = "found" | "absent" | "failed";

/**
 * Whether `sessionId` has a transcript under `projectsRoot`. `cwd` only buys the
 * fast path: the derived slug is one `lstat` and hits for nearly every real
 * conversation, so resuming one never pays for the scan.
 */
export async function observeClaudeTranscript(
  sessionId: string,
  cwd: string | undefined,
  projectsRoot: string | null,
  options: Pick<ClaudeStoreOptions, "fs" | "timeoutMs"> = {}
): Promise<ClaudeTranscriptObservation> {
  if (!projectsRoot || !SESSION_ID_PATTERN.test(sessionId) || isCoolingDown(projectsRoot)) {
    return "unknown";
  }
  const fs = options.fs ?? nodeFs;
  const deadline = Date.now() + (options.timeoutMs ?? CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS);

  if (cwd) {
    const direct = path.join(
      projectsRoot,
      deriveProjectSlug(cwd),
      `${sessionId}${TRANSCRIPT_SUFFIX}`
    );
    const lookup = fs.lstat(direct).then(
      (): DirectLookup => "found",
      (error: unknown): DirectLookup => (isAbsence(error) ? "absent" : "failed")
    );
    const outcome = await within(lookup, deadline - Date.now());
    if (outcome === TIMED_OUT) {
      markUnreachable(projectsRoot);
      return "unknown";
    }
    if (outcome === "found") return "present";
    if (outcome === "failed") return "unknown";
  }

  const ids = await readTranscriptIndex(projectsRoot, fs, deadline - Date.now());
  if (!ids) return "unknown";
  return ids.has(sessionId.toLowerCase()) ? "present" : "missing";
}

/**
 * The session id to assign afresh when a Claude launch would resume a
 * conversation Claude Code never wrote (#12371), or undefined when the command
 * should run exactly as given.
 *
 * Only a proven absence in the store this pane will actually read changes
 * anything. Reassigning an id that does have a conversation is rejected by the
 * CLI as already in use, so `unknown` keeps the resume that would have run
 * before this check existed. `env` is the spawn's own overrides.
 */
export async function findUntouchedClaudeSession(
  command: string,
  launchAgentId: string | undefined,
  pane: { cwd: string; agentSessionId?: string; env?: EnvLike },
  options: ClaudeStoreOptions = {}
): Promise<string | undefined> {
  if (launchAgentId !== CLAUDE_AGENT_ID) return undefined;
  const relaunch = relaunchResumeAsAssignedSession(command, launchAgentId);
  if (!relaunch) return undefined;
  // A pane on record under a different id than the one its command resumes is
  // not a shape Daintree builds. Leave it to the CLI rather than reassign the
  // wrong conversation's id.
  if (pane.agentSessionId && pane.agentSessionId !== relaunch.sessionId) return undefined;
  const projectsRoot = resolvePaneClaudeProjectsRoot(pane.env, options);
  const observation = await observeClaudeTranscript(
    relaunch.sessionId,
    pane.cwd,
    projectsRoot,
    options
  );
  return observation === "missing" ? relaunch.sessionId : undefined;
}

type SessionRecordFacts = Pick<AgentSessionRecord, "agentId" | "sessionId" | "bookmark" | "title">;

/**
 * A history record that could be an untouched pane: an unbookmarked Claude
 * session still wearing Claude's pre-conversation title. A record doesn't say
 * which store its pane read — a preset can relocate it — so the title is what
 * keeps a real conversation, in a store this process can't see, from being
 * judged against the wrong one.
 */
function couldBeUntouchedClaudeSession(record: SessionRecordFacts): boolean {
  if (record.agentId !== CLAUDE_AGENT_ID || record.bookmark !== undefined) return false;
  if (!SESSION_ID_PATTERN.test(record.sessionId)) return false;
  const title = record.title?.trim();
  return !title || UNTOUCHED_TITLE_PATTERN.test(title);
}

/**
 * True only for a record that could be an untouched pane and whose transcript is
 * proven missing — the journal's cue not to record a session nobody can resume.
 */
export async function isClaudeSessionWithoutTranscript(
  record: SessionRecordFacts & Pick<AgentSessionRecord, "cwd">,
  options: ClaudeStoreOptions = {}
): Promise<boolean> {
  if (!couldBeUntouchedClaudeSession(record)) return false;
  const projectsRoot = resolvePaneClaudeProjectsRoot(undefined, options);
  const observation = await observeClaudeTranscript(
    record.sessionId,
    record.cwd,
    projectsRoot,
    options
  );
  return observation === "missing";
}

/**
 * Drops untouched Claude sessions from a history list, so the resume list stops
 * offering conversations `--resume` can never open. Read-side only: the journal
 * on disk is untouched, bookmarks and retitled sessions always stay, and a store
 * that can't be pinned down or read in full filters nothing.
 */
export async function dropClaudeSessionsWithoutTranscript<T extends SessionRecordFacts>(
  records: T[],
  options: ClaudeStoreOptions = {}
): Promise<T[]> {
  if (!records.some(couldBeUntouchedClaudeSession)) return records;
  const projectsRoot = resolvePaneClaudeProjectsRoot(undefined, options);
  if (!projectsRoot || isCoolingDown(projectsRoot)) return records;
  const ids = await readTranscriptIndex(
    projectsRoot,
    options.fs ?? nodeFs,
    options.timeoutMs ?? CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS
  );
  if (!ids) return records;
  return records.filter(
    (record) => !couldBeUntouchedClaudeSession(record) || ids.has(record.sessionId.toLowerCase())
  );
}

export function __resetClaudeSessionStoreForTests(): void {
  inFlightScans.clear();
  unreachableUntil.clear();
}
