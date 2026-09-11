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
 * Every answer is one observation of one store at one moment and is never kept:
 * the first message can create the transcript right after a `missing`.
 */

import { lstat, readdir } from "fs/promises";
import os from "os";
import path from "path";
import { relaunchResumeAsAssignedSession } from "../../../shared/types/agentSettings.js";
import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";
import { getEnvVar, hasEnvVar } from "../pty/EnvironmentFilter.js";
import { withTimeout } from "../../utils/withTimeout.js";
import { deriveProjectSlug } from "./ClaudeSubagentReader.js";

/**
 * `unknown` covers everything that isn't proof either way: a store that can't be
 * located or read in full, a lookup that ran out of time, an id that can't be one
 * of Claude's. Callers treat it as "do what you did before".
 */
export type ClaudeTranscriptObservation = "present" | "missing" | "unknown";

/** Budget for one lookup, fallback scan included. A dead network mount must not hold up a launch. */
export const CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS = 1_500;

const CLAUDE_AGENT_ID = "claude";
const TRANSCRIPT_SUFFIX = ".jsonl";
/** Concurrent project-directory reads during a scan. */
const SCAN_CONCURRENCY = 8;
/** Claude Code only accepts a UUID as a session id, so nothing else can name a transcript it wrote. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Injection seam for tests. Both are plain `fs/promises` reads. */
export interface ClaudeStoreFs {
  lstat(target: string): Promise<unknown>;
  readdir(target: string): Promise<string[]>;
}

export interface ClaudeStoreOptions {
  env?: EnvLike;
  timeoutMs?: number;
  fs?: ClaudeStoreFs;
}

const nodeFs: ClaudeStoreFs = {
  lstat: (target) => lstat(target),
  readdir: (target) => readdir(target),
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * `<configDir>/projects`, or null when there is no one place to look.
 * `CLAUDE_CONFIG_DIR` relocates the store; a relative value resolves against the
 * CLI's own cwd, which differs per pane, so it is refused rather than resolved
 * against Daintree's.
 */
export function resolveClaudeProjectsRoot(env: EnvLike = process.env): string | null {
  const override = getEnvVar(env, "CLAUDE_CONFIG_DIR")?.trim();
  if (override) return path.isAbsolute(override) ? path.join(override, "projects") : null;
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Every session id with a transcript anywhere in the store, or null when the
 * store couldn't be read in full.
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
    if (errorCode(error) !== "ENOENT") return null;
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
        if (name.endsWith(TRANSCRIPT_SUFFIX)) ids.add(name.slice(0, -TRANSCRIPT_SUFFIX.length));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, projectDirs.length) }, worker));
  return failed || isCancelled() ? null : ids;
}

const inFlightScans = new Map<string, Promise<Set<string> | null>>();

/**
 * Shares one scan between concurrent callers — a session restore asks for every
 * pane at once — and forgets it the moment it settles. A timed-out scan stops
 * reading further directories; `fs` calls already started can't be recalled.
 */
function readTranscriptIndex(
  projectsRoot: string,
  fs: ClaudeStoreFs,
  timeoutMs: number
): Promise<Set<string> | null> {
  const pending = inFlightScans.get(projectsRoot);
  if (pending) return pending;
  let cancelled = false;
  const scan = withTimeout(
    scanTranscriptIds(projectsRoot, fs, () => cancelled),
    timeoutMs,
    "Claude transcript scan timed out"
  )
    .catch(() => {
      cancelled = true;
      return null;
    })
    .finally(() => {
      inFlightScans.delete(projectsRoot);
    });
  inFlightScans.set(projectsRoot, scan);
  return scan;
}

/**
 * Whether `sessionId` has a transcript in the Claude store `env` points at.
 * `cwd` only buys the fast path: the derived slug is one `lstat` and hits for
 * nearly every real conversation, so resuming one never pays for the scan.
 */
export async function observeClaudeTranscript(
  sessionId: string,
  cwd: string | undefined,
  options: ClaudeStoreOptions = {}
): Promise<ClaudeTranscriptObservation> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return "unknown";
  const projectsRoot = resolveClaudeProjectsRoot(options.env);
  if (!projectsRoot) return "unknown";
  const fs = options.fs ?? nodeFs;
  const deadline = Date.now() + (options.timeoutMs ?? CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS);

  if (cwd) {
    const direct = path.join(
      projectsRoot,
      deriveProjectSlug(cwd),
      `${sessionId}${TRANSCRIPT_SUFFIX}`
    );
    try {
      await withTimeout(
        fs.lstat(direct),
        deadline - Date.now(),
        "Claude transcript lookup timed out"
      );
      return "present";
    } catch (error) {
      if (!isAbsence(error)) return "unknown";
    }
  }

  const ids = await readTranscriptIndex(projectsRoot, fs, Math.max(0, deadline - Date.now()));
  if (!ids) return "unknown";
  return ids.has(sessionId) ? "present" : "missing";
}

/**
 * The session id to assign afresh when a Claude launch would resume a
 * conversation Claude Code never wrote (#12371), or undefined when the command
 * should run exactly as given.
 *
 * Only a proven absence changes anything. Reassigning an id that does have a
 * conversation is rejected by the CLI as already in use, so `unknown` keeps the
 * resume that would have run before this check existed.
 *
 * `env` is the spawn's own overrides; Daintree's environment fills in whatever
 * they leave out, which is where the pane inherits the rest from.
 */
export async function findUntouchedClaudeSession(
  command: string,
  launchAgentId: string | undefined,
  context: { cwd: string; agentSessionId?: string; env?: EnvLike },
  options: Omit<ClaudeStoreOptions, "env"> = {}
): Promise<string | undefined> {
  if (launchAgentId !== CLAUDE_AGENT_ID) return undefined;
  const relaunch = relaunchResumeAsAssignedSession(command, launchAgentId);
  if (!relaunch) return undefined;
  // A pane on record under a different id than the one its command resumes is
  // not a shape Daintree builds. Leave it to the CLI rather than reassign the
  // wrong conversation's id.
  if (context.agentSessionId && context.agentSessionId !== relaunch.sessionId) return undefined;
  const env =
    context.env && hasEnvVar(context.env, "CLAUDE_CONFIG_DIR") ? context.env : process.env;
  const observation = await observeClaudeTranscript(relaunch.sessionId, context.cwd, {
    ...options,
    env,
  });
  return observation === "missing" ? relaunch.sessionId : undefined;
}

type SessionRecordIdentity = Pick<AgentSessionRecord, "agentId" | "sessionId" | "bookmark">;

function isUnpinnedClaudeSession(record: SessionRecordIdentity): boolean {
  return (
    record.agentId === CLAUDE_AGENT_ID &&
    record.bookmark === undefined &&
    SESSION_ID_PATTERN.test(record.sessionId)
  );
}

/**
 * True only when `record` is an unbookmarked Claude session whose transcript is
 * proven missing — the journal's cue not to record a session nobody can resume.
 */
export async function isClaudeSessionWithoutTranscript(
  record: SessionRecordIdentity & Pick<AgentSessionRecord, "cwd">,
  options: ClaudeStoreOptions = {}
): Promise<boolean> {
  if (!isUnpinnedClaudeSession(record)) return false;
  return (await observeClaudeTranscript(record.sessionId, record.cwd, options)) === "missing";
}

/**
 * Drops Claude history entries with no conversation behind them, so the resume
 * list stops offering sessions `--resume` can never open. Read-side only: the
 * journal on disk is untouched, a bookmark always stays (the user pinned it),
 * and a store that can't be read in full filters nothing.
 */
export async function dropClaudeSessionsWithoutTranscript<T extends SessionRecordIdentity>(
  records: T[],
  options: ClaudeStoreOptions = {}
): Promise<T[]> {
  if (!records.some(isUnpinnedClaudeSession)) return records;
  const projectsRoot = resolveClaudeProjectsRoot(options.env);
  if (!projectsRoot) return records;
  const ids = await readTranscriptIndex(
    projectsRoot,
    options.fs ?? nodeFs,
    options.timeoutMs ?? CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS
  );
  if (!ids) return records;
  return records.filter((record) => !isUnpinnedClaudeSession(record) || ids.has(record.sessionId));
}
