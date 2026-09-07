/**
 * Resolves which Codex thread a terminal is running, then reads that thread's
 * spawned subagents. Read-only throughout — see CodexAppServerClient.
 *
 * Two resolutions live here and they answer different questions. The subagent
 * one asks "which conversation is this LIVE terminal in", and refuses to guess.
 * `resolveCodexResumeLatestSession` asks "which conversation would `codex resume
 * --last` open in this folder" for a pane being restored cold (#12178), where
 * there is no terminal to ask and the answer is a fact about the CLI's own
 * selection rule rather than an attribution. They share the protocol plumbing
 * below and nothing else.
 *
 * Everything leaves here in the provider-neutral shape from
 * `shared/types/ipc/agentSubagents`, so the renderer's list and transcript are
 * the same code that renders Claude's children. The protocol below is the only
 * Codex-specific part, which is the whole point of the split.
 *
 * Attribution is the hard part. Daintree only learns a Codex session id from
 * the `codex resume` footer during post-quit teardown, so a *running* terminal
 * has no id to key off. The fallback is the terminal's own cwd plus recency,
 * which is exact per worktree and ambiguous when two Codex sessions share one.
 * When it is ambiguous the caller is told so rather than silently shown some
 * other session's children.
 */

import { realpath } from "fs/promises";
import { getPtyClient } from "../PtyClient.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  CodexAppServerError,
  runCodexAppServerSession,
  type CodexAppServerCall,
} from "./CodexAppServerClient.js";
import {
  SUBAGENT_LIST_LIMIT,
  SUBAGENT_MESSAGE_MAX_CHARS,
  SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT,
  trimPreservingTask,
  type AgentSubagent,
  type AgentSubagentMessage,
  type AgentSubagentStatus,
  type AgentSubagentUnavailableReason,
  type AgentSubagentsResult,
  type AgentSubagentTranscriptResult,
  type CodexFolderSession,
  type CodexFolderSessionsResult,
} from "../../../shared/types/ipc/agentSubagents.js";

/**
 * Turns fetched per transcript read. A turn carries a prompt and an answer, so
 * this is the page size behind the shared per-message cap rather than a second
 * limit on top of it.
 */
const CODEX_SUBAGENT_TRANSCRIPT_TURN_LIMIT = 12;

/** How Codex settled on a parent. Never crosses IPC — it steers the read, not the UI. */
type CodexSubagentMatch = "session-id" | "spawn-time";

/** How many root threads in the cwd are considered as parent candidates. */
const PARENT_CANDIDATE_LIMIT = 25;

/**
 * Whole budget for the restore-time resume-latest lookup, well under the
 * transport's 15s default. Restore waits on this before it can launch the pane,
 * and the answer is an optimisation over an already-working fallback — so it
 * has to give up long before a user would notice the pane is late.
 */
const RESUME_LATEST_LOOKUP_TIMEOUT_MS = 2_000;
/**
 * A session whose last activity is older than this at the moment the terminal
 * launched cannot be the one the terminal is running — it went quiet before the
 * terminal existed. Small slack absorbs clock skew between the two.
 */
const STALE_ACTIVITY_SLACK_SECONDS = 5 * 60;

/** Protocol timestamps are Unix seconds; the renderer works in milliseconds. */
function secondsToMs(seconds: unknown): number {
  return typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/** Shape of the protocol's `Thread`, narrowed to the fields this feature reads. */
interface RawThread {
  id?: unknown;
  /**
   * The session tree this thread belongs to — the value `codex resume` takes.
   * Distinct from `id` in the protocol (a subagent thread has its own id but
   * shares its root's session), though for a root the two coincide.
   */
  sessionId?: unknown;
  parentThreadId?: unknown;
  preview?: unknown;
  cwd?: unknown;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  recencyAt?: unknown;
  agentNickname?: unknown;
  agentRole?: unknown;
  canAcceptDirectInput?: unknown;
}

const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);

/**
 * `ThreadStatus` is a tagged union, not a string enum. A malformed or
 * newly-invented arm lands on `unknown` rather than throwing: a protocol that
 * grows a status should degrade to "nothing to report", not blank the list.
 *
 * The two are told apart on the way out. `notLoaded` is the protocol declining
 * to hydrate a thread, which is what Daintree sees for nearly every child;
 * anything unrecognised is a shape this build does not know. Collapsing them
 * would hide a schema change behind a state we expect to see constantly.
 */
export function toSubagentStatus(raw: unknown): AgentSubagentStatus {
  if (!raw || typeof raw !== "object") return { type: "unknown", reason: "unrecognized" };
  const type = (raw as { type?: unknown }).type;
  if (type === "notLoaded") return { type: "unknown", reason: "not-loaded" };
  if (type === "idle") return { type: "idle" };
  if (type === "systemError") return { type: "error" };
  if (type === "active") {
    const flags = (raw as { activeFlags?: unknown }).activeFlags;
    const known = Array.isArray(flags)
      ? flags.filter((flag) => ACTIVE_FLAGS.has(flag as string))
      : [];
    // Approval outranks input: a child held at a permission prompt cannot be
    // unblocked by typing at it, so that is the one worth naming.
    if (known.includes("waitingOnApproval")) return { type: "blocked", reason: "approval" };
    if (known.includes("waitingOnUserInput")) return { type: "blocked", reason: "input" };
    return { type: "working" };
  }
  return { type: "unknown", reason: "unrecognized" };
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Most recent sign of life, preferring the field that only a turn advances. */
function activityOf(thread: RawThread): number {
  return (
    numberOf(thread.recencyAt) ?? numberOf(thread.updatedAt) ?? numberOf(thread.createdAt) ?? 0
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toSubagent(raw: RawThread): AgentSubagent | null {
  const threadId = asString(raw.id);
  if (!threadId) return null;
  return {
    id: threadId,
    // Codex's nickname is the handle its own transcript uses for the child, so
    // it lands in the same slot as Claude's description of the delegated task.
    label: asString(raw.agentNickname),
    role: asString(raw.agentRole),
    preview: typeof raw.preview === "string" ? raw.preview : "",
    // Neither is on the wire: `thread/list` reports no model, and Codex's
    // children are all one level down, so a depth here would be a constant
    // dressed up as an observation.
    model: null,
    depth: null,
    status: toSubagentStatus(raw.status),
    createdAt: secondsToMs(raw.createdAt),
    updatedAt: secondsToMs(raw.updatedAt),
  };
}

export type ParentSelection =
  | { parentThreadId: string; matchedBy: CodexSubagentMatch }
  | { parentThreadId: null; reason: "no-session" | "ambiguous-session" };

/**
 * Identify the root thread this terminal is running, or refuse to.
 *
 * Folder plus timestamps is all we have, and it is not an identity. Two Codex
 * sessions live in one worktree are genuinely indistinguishable from outside:
 * ranking them by recency hands terminal A the children of terminal B, and
 * ranking by proximity to launch does the same whenever A's session was started
 * by hand some time after A itself. Either way the wrong list looks exactly
 * like the right one, and the user has nothing to check it against.
 *
 * So the rule is a filter, not a ranking. Drop every root that had already gone
 * quiet before this terminal launched — whatever the terminal is running, it
 * isn't one of those. If exactly one survives, that is the session. If more
 * than one does, say so and show nothing.
 *
 * The cost is real: two concurrent Codex terminals in one worktree both lose
 * the list. That is the correct trade for a feature whose whole value is
 * telling you what *your* agent delegated. An exact `agentSessionId` bypasses
 * all of this.
 */
export function selectParentThread(
  threads: RawThread[],
  input: { spawnedAtMs?: number; agentSessionId?: string | null }
): ParentSelection {
  if (input.agentSessionId) {
    return { parentThreadId: input.agentSessionId, matchedBy: "session-id" };
  }

  const spawnedAtSeconds =
    typeof input.spawnedAtMs === "number" && input.spawnedAtMs > 0
      ? Math.floor(input.spawnedAtMs / 1000)
      : null;

  const roots = threads.filter(
    (thread) => asString(thread.id) !== null && asString(thread.parentThreadId) === null
  );

  // Without a launch time there is nothing to filter on, so every root stays a
  // candidate and only a solitary one can be answered for.
  const live =
    spawnedAtSeconds === null
      ? roots
      : roots.filter(
          (thread) => activityOf(thread) >= spawnedAtSeconds - STALE_ACTIVITY_SLACK_SECONDS
        );

  if (live.length === 0) return { parentThreadId: null, reason: "no-session" };
  if (live.length > 1) return { parentThreadId: null, reason: "ambiguous-session" };

  const only = asString(live[0]?.id);
  return only
    ? { parentThreadId: only, matchedBy: "spawn-time" }
    : { parentThreadId: null, reason: "no-session" };
}

interface RawTurnItem {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

function itemText(item: RawTurnItem): string {
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Flatten a turn's items to the messages worth reading. Reasoning items are
 * dropped: they are the child's scratchpad, not its output, and they dwarf the
 * answer.
 */
export function toSubagentMessages(raw: unknown): AgentSubagentMessage[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const messages: AgentSubagentMessage[] = [];
  for (const item of items as RawTurnItem[]) {
    if (!item || typeof item !== "object") continue;
    const role =
      item.type === "userMessage" ? "task" : item.type === "agentMessage" ? "reply" : null;
    if (!role) continue;
    const text = itemText(item).trim();
    if (!text) continue;
    messages.push({ role, text: text.slice(0, SUBAGENT_MESSAGE_MAX_CHARS) });
  }
  return messages;
}

function unavailable(
  reason: AgentSubagentUnavailableReason,
  detail?: string
): { status: "unavailable"; reason: AgentSubagentUnavailableReason; detail?: string } {
  return detail
    ? { status: "unavailable", reason, detail: scrubSecrets(detail) }
    : { status: "unavailable", reason };
}

function toUnavailable(error: unknown) {
  if (error instanceof CodexAppServerError) return unavailable(error.reason, error.message);
  return unavailable("protocol-error", formatErrorMessage(error, "Codex query failed"));
}

interface ResolvedTerminal {
  cwds: string[];
  spawnedAtMs?: number;
  agentSessionId?: string | null;
}

/**
 * Read the terminal's identity from the pty-host record rather than trusting
 * the renderer. The renderer supplies only a terminal id, so a compromised or
 * buggy caller cannot point this at an unrelated folder's Codex history.
 */
async function resolveTerminal(
  terminalId: string
): Promise<ResolvedTerminal | { status: "unavailable"; reason: AgentSubagentUnavailableReason }> {
  const info = await getPtyClient().getTerminalAsync(terminalId);
  if (!info) return { status: "unavailable", reason: "terminal-unknown" };
  // Live detection wins over the launch hint, matching the renderer. A pane
  // relaunched onto another agent keeps its original `launchAgentId`, and an
  // `||` here would let a direct IPC call read the previous agent's children.
  if ((info.detectedAgentId ?? info.launchAgentId) !== "codex") {
    return { status: "unavailable", reason: "provider-mismatch" };
  }
  if (!info.cwd) return { status: "unavailable", reason: "terminal-unknown" };

  return {
    cwds: await resolveCwdSpellings(info.cwd),
    spawnedAtMs: info.spawnedAt,
    agentSessionId: info.agentSessionId ?? null,
  };
}

/**
 * Every spelling of one directory that `thread/list` might have recorded.
 *
 * Its cwd filter is an exact string match, so a path recorded through a symlink
 * (macOS `/tmp` → `/private/tmp` being the common one) would match nothing.
 * Query both spellings when they differ.
 */
async function resolveCwdSpellings(cwd: string): Promise<string[]> {
  const cwds = [cwd];
  try {
    const resolved = await realpath(cwd);
    if (resolved && resolved !== cwd) cwds.push(resolved);
  } catch {
    // A deleted or unreadable worktree just means the literal path is all we have.
  }
  return cwds;
}

async function listThreadsInCwd(call: CodexAppServerCall, cwds: string[]): Promise<RawThread[]> {
  const response = await call<{ data?: unknown }>("thread/list", {
    cwd: cwds,
    sortKey: "recency_at",
    sortDirection: "desc",
    limit: PARENT_CANDIDATE_LIMIT,
    // Reads the state-DB index instead of rescanning JSONL rollouts to repair
    // metadata: ~3ms against ~900ms, for data this feature only displays.
    useStateDbOnly: true,
  });
  return Array.isArray(response?.data) ? (response.data as RawThread[]) : [];
}

async function listChildren(
  call: CodexAppServerCall,
  parentThreadId: string
): Promise<RawThread[]> {
  // `sourceKinds` is deliberately omitted: relationship-filtered requests
  // include every source kind only when it is absent, and an explicit list
  // would fall back to the interactive-only default and return nothing.
  // Review and Guardian threads are excluded by the server, since they do not
  // participate in the spawn-edge lifecycle this filter walks.
  const response = await call<{ data?: unknown }>("thread/list", {
    parentThreadId,
    limit: SUBAGENT_LIST_LIMIT,
    useStateDbOnly: true,
  });
  return Array.isArray(response?.data) ? (response.data as RawThread[]) : [];
}

/**
 * Confirm a launch-recorded session id really names a live Codex thread for
 * this folder before trusting it. `agentSessionId` is generic launch metadata:
 * a pane launched as another agent carries that agent's id, and a reused pane
 * carries the id of a session that has since been replaced. One cheap
 * `thread/read` on an already-spawned server settles both.
 */
async function verifySessionThread(
  call: CodexAppServerCall,
  threadId: string,
  terminal: ResolvedTerminal
): Promise<boolean> {
  try {
    const response = await call<{ thread?: RawThread }>("thread/read", { threadId });
    const thread = response?.thread;
    if (!thread || typeof thread.cwd !== "string" || !terminal.cwds.includes(thread.cwd)) {
      return false;
    }
    // A pane whose agent exited can be reused for a fresh session the recorded
    // id no longer describes. The prior session is in the right folder but went
    // quiet before this launch, so liveness is what separates the two.
    const spawnedAtSeconds =
      typeof terminal.spawnedAtMs === "number" && terminal.spawnedAtMs > 0
        ? Math.floor(terminal.spawnedAtMs / 1000)
        : null;
    if (spawnedAtSeconds === null) return true;
    return activityOf(thread) >= spawnedAtSeconds - STALE_ACTIVITY_SLACK_SECONDS;
  } catch {
    // No such thread, or a server that won't answer — either way, don't trust it.
    return false;
  }
}

async function resolveParent(
  call: CodexAppServerCall,
  terminal: ResolvedTerminal
): Promise<ParentSelection> {
  if (terminal.agentSessionId) {
    if (await verifySessionThread(call, terminal.agentSessionId, terminal)) {
      return selectParentThread([], terminal);
    }
  }
  return selectParentThread(await listThreadsInCwd(call, terminal.cwds), {
    spawnedAtMs: terminal.spawnedAtMs,
  });
}

export async function listCodexSubagents(terminalId: string): Promise<AgentSubagentsResult> {
  const resolved = await resolveTerminal(terminalId);
  if ("status" in resolved) return resolved;

  try {
    return await runCodexAppServerSession(async (call) => {
      const selection = await resolveParent(call, resolved);
      if (selection.parentThreadId === null) return unavailable(selection.reason);

      const children = await listChildren(call, selection.parentThreadId);
      return {
        status: "ok" as const,
        provider: "codex" as const,
        parentId: selection.parentThreadId,
        subagents: children
          .map(toSubagent)
          .filter((child): child is AgentSubagent => child !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      };
    });
  } catch (error) {
    return toUnavailable(error);
  }
}

export async function readCodexSubagentTranscript(
  terminalId: string,
  subagentId: string
): Promise<AgentSubagentTranscriptResult> {
  const resolved = await resolveTerminal(terminalId);
  if ("status" in resolved) return resolved;

  try {
    return await runCodexAppServerSession(async (call) => {
      const selection = await resolveParent(call, resolved);
      // Ambiguity fails the read too, not just the list: an unresolved parent
      // means we cannot say the requested thread belongs to this terminal.
      if (selection.parentThreadId === null) return unavailable(selection.reason);

      // Membership check before any read: the renderer names a thread id, and
      // without this a wrong or hostile id would read an unrelated Codex
      // conversation that has nothing to do with this terminal.
      const children = await listChildren(call, selection.parentThreadId);
      if (!children.some((child) => asString(child.id) === subagentId)) {
        return unavailable("subagent-not-found");
      }

      const response = await call<{ data?: unknown }>("thread/turns/list", {
        threadId: subagentId,
        limit: CODEX_SUBAGENT_TRANSCRIPT_TURN_LIMIT,
        sortDirection: "desc",
        // `summary` carries the user prompt and the agent's answer without the
        // reasoning trace. `thread/read` with `includeTurns` would also work
        // but is the deprecated full-hydration path.
        itemsView: "summary",
      });
      const turns = Array.isArray(response?.data) ? response.data : [];
      // The page arrives newest-first; the shared transcript reads oldest-first
      // so a child shows the task it was given above the answer it gave.
      const messages = [...turns].reverse().flatMap(toSubagentMessages);
      const overflowed = messages.length > SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT;
      // A plain tail slice would drop the delegated task whenever one page
      // carried more readable items than the cap.
      trimPreservingTask(messages, SUBAGENT_TRANSCRIPT_MESSAGE_LIMIT);
      return {
        status: "ok" as const,
        subagentId,
        messages,
        // A full page means the protocol had at least this much and older turns
        // were never asked for, which is the same thing to whoever is reading.
        truncated: turns.length >= CODEX_SUBAGENT_TRANSCRIPT_TURN_LIMIT || overflowed,
      };
    });
  } catch (error) {
    return toUnavailable(error);
  }
}

/**
 * A session id is about to be interpolated into a shell command by
 * `buildResumeCommand`. It arrives as JSON from another process, so it is
 * checked against the same shape Codex itself prints in its `codex resume <id>`
 * footer (the agent config's `sessionIdPattern`) before it can get there.
 */
const CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ResumeLatestSelection = { sessionId: string } | { sessionId: null };

/**
 * Which session `codex resume --last` would open, given one page of that
 * folder's threads.
 *
 * `--last` is "the most recent session in this directory", so the rule is a
 * ranking, not the strict attribution filter `selectParentThread` applies — that
 * one exists to refuse to guess which of two live sessions a terminal owns, and
 * calling it here would decline the very question this answers.
 *
 * Only subagent threads are excluded (`--last` opens a root), and only the tie
 * at the top is refused: a single most-recent root is exactly what the CLI would
 * pick, while two roots sharing that timestamp is a coin-flip whose tie-break
 * lives inside Codex. Refusing there costs nothing, since the fallback is to let
 * the CLI make the same choice itself.
 */
export function selectResumeLatestThread(threads: readonly RawThread[]): ResumeLatestSelection {
  let best: { sessionId: string; activity: number } | undefined;
  let tied = false;
  const seen = new Set<string>();

  for (const thread of threads) {
    const threadId = asString(thread.id);
    if (threadId === null) continue;
    // A subagent's row carries its parent's `sessionId`, so an unfiltered scan
    // could rank a child's activity and hand back the root it belongs to.
    if (asString(thread.parentThreadId) !== null) continue;
    // One page should not repeat a thread, but ranking a duplicate against
    // itself would read as a tie and refuse a session that has no rival.
    if (seen.has(threadId)) continue;
    seen.add(threadId);

    // `sessionId` is the value `codex resume` accepts; for a root it equals the
    // thread id, and an older server that omits it falls back to that.
    const sessionId = asString(thread.sessionId) ?? threadId;
    if (!CODEX_SESSION_ID_PATTERN.test(sessionId)) continue;

    const activity = activityOf(thread);
    if (best === undefined || activity > best.activity) {
      best = { sessionId, activity };
      tied = false;
    } else if (activity === best.activity && sessionId !== best.sessionId) {
      tied = true;
    }
  }

  if (best === undefined || tied) return { sessionId: null };
  return { sessionId: best.sessionId };
}

/**
 * Resolve the session `codex resume --last` would open in `cwd`, or null.
 *
 * Called at restore for a cold pane that would otherwise launch with `--last`
 * and run a conversation whose id Daintree never learns (#12178). Freezing the
 * choice here is only correct if the query reproduces the CLI's own selection,
 * which the request shape below does exactly — verified against codex-cli
 * 0.153.0's generated protocol schema and `codex resume --help`:
 *
 *   - `--last` is cwd-scoped: `--all` is documented as "disables cwd filtering".
 *   - `--last` skips non-interactive sessions unless `--include-non-interactive`
 *     is passed, and `ThreadListParams.sourceKinds` "defaults to interactive
 *     sources" when omitted. So `sourceKinds` must stay ABSENT here — naming
 *     the kinds explicitly would change the filter rather than restate it.
 *   - `archived` omitted returns only non-archived threads, matching the picker.
 *
 * Never throws: a missing CLI, a wedged server or a timeout resolves to null,
 * and the caller launches with plain `--last` exactly as it does today.
 */
export async function resolveCodexResumeLatestSession(cwd: string): Promise<string | null> {
  try {
    return await runCodexAppServerSession(
      async (call) => {
        // Resolved inside the session so the transport's deadline covers it
        // too: realpath hangs indefinitely on a dead network mount, and this
        // runs on the restore path.
        const threads = await listThreadsInCwd(call, await resolveCwdSpellings(cwd));
        return selectResumeLatestThread(threads).sessionId;
      },
      { timeoutMs: RESUME_LATEST_LOOKUP_TIMEOUT_MS }
    );
  } catch {
    // Degrading to `--last` loses the id capture; failing the restore would lose
    // the pane. The pane is worth more.
    return null;
  }
}

function toFolderSession(thread: RawThread): CodexFolderSession | null {
  // `codex resume` takes `sessionId`; for a root thread it equals `id`, and an
  // older server that omits the field falls back to that (matches
  // `selectResumeLatestThread`, which resolves the same value for the same
  // reason).
  const id = asString(thread.sessionId) ?? asString(thread.id);
  // This id reaches `buildResumeCommand` and is interpolated into a shell
  // command the instant the user picks it — same shape check
  // `selectResumeLatestThread` applies before trusting a session id from the
  // wire.
  if (!id || !CODEX_SESSION_ID_PATTERN.test(id)) return null;
  return {
    id,
    // The session's own first message — conversation text. Crosses IPC as-is
    // (see the type's doc comment) but must never be logged.
    preview: typeof thread.preview === "string" ? thread.preview : "",
    updatedAt: secondsToMs(activityOf(thread)),
  };
}

/**
 * List the Codex sessions recorded for a folder, for the "Find session"
 * action on the lost-session banner (#12182) — the user picks one to reopen
 * when restore couldn't reattach to it automatically.
 *
 * Root threads only: a picker offering to reopen a delegated subagent thread
 * would be reopening something that was never its own conversation.
 *
 * `codexHome` should be the pane's own launch env when it carries one
 * (renderer resolves this from `PtyPanelData.env`, matching the lookup
 * `resolveNamedResumeLatestSession` already does for the same reason) — this
 * client has no way to learn a pane's redirected profile on its own, and
 * querying main's default one would silently show the wrong folder's history
 * or nothing at all.
 */
export async function listCodexSessionsForCwd(
  cwd: string,
  codexHome?: string
): Promise<CodexFolderSessionsResult> {
  try {
    return await runCodexAppServerSession(
      async (call) => {
        const threads = await listThreadsInCwd(call, await resolveCwdSpellings(cwd));
        const sessions = threads
          .filter((thread) => asString(thread.parentThreadId) === null)
          .map(toFolderSession)
          .filter((session): session is CodexFolderSession => session !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return { status: "ok" as const, sessions };
      },
      { codexHome }
    );
  } catch (error) {
    return toUnavailable(error);
  }
}
