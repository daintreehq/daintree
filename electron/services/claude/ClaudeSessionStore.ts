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
 * absence can only ever be proven in one store. Everything here starts by asking
 * which store a pane reads, and answers `unknown` unless that is certain:
 * reading the wrong one would call a live conversation missing, and a relaunch
 * built on that is rejected by the CLI as already in use.
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
  getShellEnvironmentObservation,
  type ShellEnvironmentObservation,
} from "../../setup/shellEnvironmentObservation.js";
import { getEnvVar, hasEnvVar } from "../pty/EnvironmentFilter.js";
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
/** Terminals whose store is remembered from their spawn; the oldest go first. */
const PANE_STORE_MEMORY = 1_024;
/** Claude Code only accepts a UUID as a session id, so nothing else can name a transcript it wrote. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The titles a Claude pane carries before its first message: Daintree's label
 * for the agent and Claude Code's idle title, with or without its status glyph.
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
  /** Daintree's own environment, for the shell a terminal gets by default. */
  env?: EnvLike;
  readShellObservation?: () => ShellEnvironmentObservation | undefined;
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

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The `projects/` directory a Claude pane will read, or null unless that is
 * certain.
 *
 * A pane's shell sources the user's profile, which can export, change, or unset
 * `CLAUDE_CONFIG_DIR`, and main never sees the result. Certainty therefore needs
 * the pane to start from exactly what the startup probe saw: the same shell, and
 * no `CLAUDE_CONFIG_DIR` of its own for that profile to treat differently. Its
 * profile then does to the pane whatever it did to the probe. Anything else — a
 * different shell, a pane-level override, no probe yet — is unknown, and so is
 * Windows, whose PowerShell and cmd profiles are never probed.
 *
 * `pane.shell` defaults to the shell a terminal gets when nothing names one.
 */
export function resolvePaneClaudeProjectsRoot(
  pane: { shell?: string; env?: EnvLike } = {},
  context: ClaudeStoreContext = {}
): string | null {
  if ((context.platform ?? process.platform) === "win32") return null;
  if (pane.env && hasEnvVar(pane.env, CONFIG_DIR_VAR)) return null;
  const observation = (context.readShellObservation ?? getShellEnvironmentObservation)();
  const shell = pane.shell ?? getEnvVar(context.env ?? process.env, "SHELL");
  if (!observation || !shell || shell !== observation.shell) return null;
  const configDir = observation.env[CONFIG_DIR_VAR];
  if (configDir === undefined) return path.join(os.homedir(), ".claude", "projects");
  // Empty or relative: what the CLI makes of either is not something to guess at.
  const trimmed = configDir.trim();
  return trimmed && path.isAbsolute(trimmed) ? path.join(trimmed, "projects") : null;
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
  const now = Date.now();
  for (const [root, until] of unreachableUntil) {
    if (until <= now) unreachableUntil.delete(root);
  }
  unreachableUntil.set(projectsRoot, now + CLAUDE_STORE_UNREACHABLE_COOLDOWN_MS);
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
    if (errorCode(error) !== "ENOENT" || isCancelled()) return null;
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
 * Only a proven absence in `pane.projectsRoot` — the store this pane will read,
 * from {@link resolvePaneClaudeProjectsRoot} — changes anything, so an uncertain
 * store or an `unknown` keeps the resume that would have run before this check.
 */
export async function findUntouchedClaudeSession(
  command: string,
  launchAgentId: string | undefined,
  pane: { cwd: string; agentSessionId?: string; projectsRoot: string | null },
  options: Pick<ClaudeStoreOptions, "fs" | "timeoutMs"> = {}
): Promise<string | undefined> {
  if (launchAgentId !== CLAUDE_AGENT_ID || !pane.projectsRoot) return undefined;
  const relaunch = relaunchResumeAsAssignedSession(command, launchAgentId);
  if (!relaunch) return undefined;
  // A pane on record under a different id than the one its command resumes is
  // not a shape Daintree builds. Leave it to the CLI rather than reassign the
  // wrong conversation's id.
  if (pane.agentSessionId && pane.agentSessionId !== relaunch.sessionId) return undefined;
  const observation = await observeClaudeTranscript(
    relaunch.sessionId,
    pane.cwd,
    pane.projectsRoot,
    options
  );
  return observation === "missing" ? relaunch.sessionId : undefined;
}

const paneStores = new Map<string, string | null>();

/**
 * Remember which store a Claude terminal was launched against, so its close is
 * judged by the pane's own store. A history record says nothing about the
 * environment its pane had; the spawn is the one place that knew.
 */
export function rememberClaudePaneStore(terminalId: string, projectsRoot: string | null): void {
  paneStores.delete(terminalId);
  paneStores.set(terminalId, projectsRoot);
  if (paneStores.size > PANE_STORE_MEMORY) {
    const oldest = paneStores.keys().next().value;
    if (oldest !== undefined) paneStores.delete(oldest);
  }
}

/**
 * True only for an unbookmarked Claude session whose transcript is proven
 * missing from the store its terminal was launched against — the journal's cue
 * not to record a session nobody can resume. A terminal whose store was never
 * remembered, or wasn't certain, never qualifies.
 */
export async function isClaudeSessionWithoutTranscript(
  record: Pick<AgentSessionRecord, "agentId" | "sessionId" | "bookmark" | "cwd">,
  terminalId: string,
  options: Pick<ClaudeStoreOptions, "fs" | "timeoutMs"> = {}
): Promise<boolean> {
  if (record.agentId !== CLAUDE_AGENT_ID || record.bookmark !== undefined) return false;
  const projectsRoot = paneStores.get(terminalId);
  if (!projectsRoot) return false;
  const observation = await observeClaudeTranscript(
    record.sessionId,
    record.cwd,
    projectsRoot,
    options
  );
  return observation === "missing";
}

type SessionRecordFacts = Pick<AgentSessionRecord, "agentId" | "sessionId" | "bookmark" | "title">;

/**
 * A history record that could be an untouched pane: an unbookmarked Claude
 * session still wearing Claude's pre-conversation title. A record outlives the
 * spawn that knew its pane's store, so an old one has to look untouched as well
 * before it is judged at all.
 */
function couldBeUntouchedClaudeSession(record: SessionRecordFacts): boolean {
  if (record.agentId !== CLAUDE_AGENT_ID || record.bookmark !== undefined) return false;
  if (!SESSION_ID_PATTERN.test(record.sessionId)) return false;
  const title = record.title?.trim();
  return !title || UNTOUCHED_TITLE_PATTERN.test(title);
}

export interface DropClaudeSessionsOptions<T> extends ClaudeStoreOptions {
  /** Records the caller knows may have run against a different store. Always kept. */
  keep?: (record: T) => boolean;
}

/**
 * Drops untouched Claude sessions from a history list, so the resume list stops
 * offering conversations `--resume` can never open. Only records that could
 * have come from a default pane are judged, against the store such a pane reads,
 * and the caller's `keep` vetoes any it knows were launched differently.
 * Read-side only: the journal on disk is untouched, and a store that can't be
 * pinned down or read in full filters nothing.
 */
export async function dropClaudeSessionsWithoutTranscript<T extends SessionRecordFacts>(
  records: T[],
  options: DropClaudeSessionsOptions<T> = {}
): Promise<T[]> {
  const judged = (record: T): boolean =>
    couldBeUntouchedClaudeSession(record) && !options.keep?.(record);
  if (!records.some(judged)) return records;
  const projectsRoot = resolvePaneClaudeProjectsRoot({}, options);
  if (!projectsRoot || isCoolingDown(projectsRoot)) return records;
  const ids = await readTranscriptIndex(
    projectsRoot,
    options.fs ?? nodeFs,
    options.timeoutMs ?? CLAUDE_TRANSCRIPT_LOOKUP_TIMEOUT_MS
  );
  if (!ids) return records;
  return records.filter((record) => !judged(record) || ids.has(record.sessionId.toLowerCase()));
}

export function __resetClaudeSessionStoreForTests(): void {
  inFlightScans.clear();
  unreachableUntil.clear();
  paneStores.clear();
}
