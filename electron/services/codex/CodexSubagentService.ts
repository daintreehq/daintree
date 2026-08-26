/**
 * Resolves which Codex thread a live terminal is running, then reads that
 * thread's spawned subagents. Read-only throughout — see CodexAppServerClient.
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
  CODEX_SUBAGENT_MESSAGE_MAX_CHARS,
  CODEX_SUBAGENT_TRANSCRIPT_TURN_LIMIT,
  type CodexSubagent,
  type CodexSubagentMatch,
  type CodexSubagentMessage,
  type CodexSubagentStatus,
  type CodexSubagentTurn,
  type CodexSubagentUnavailableReason,
  type CodexSubagentsResult,
  type CodexSubagentTranscriptResult,
} from "../../../shared/types/ipc/codexSubagents.js";

/** How many root threads in the cwd are considered as parent candidates. */
const PARENT_CANDIDATE_LIMIT = 25;
/** Cap on children returned for one parent. */
const SUBAGENT_LIMIT = 50;
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

function nullableSecondsToMs(seconds: unknown): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.round(seconds * 1000)
    : null;
}

/** Shape of the protocol's `Thread`, narrowed to the fields this feature reads. */
interface RawThread {
  id?: unknown;
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
 * `ThreadStatus` is a tagged union, not a string enum. Unknown arms collapse to
 * `notLoaded` rather than throwing: a protocol that grows a new status should
 * degrade to "nothing to report", not blank the whole list.
 */
export function toSubagentStatus(raw: unknown): CodexSubagentStatus {
  if (!raw || typeof raw !== "object") return { type: "notLoaded" };
  const type = (raw as { type?: unknown }).type;
  if (type === "idle") return { type: "idle" };
  if (type === "systemError") return { type: "systemError" };
  if (type === "active") {
    const flags = (raw as { activeFlags?: unknown }).activeFlags;
    return {
      type: "active",
      activeFlags: Array.isArray(flags)
        ? flags.filter((flag): flag is "waitingOnApproval" | "waitingOnUserInput" =>
            ACTIVE_FLAGS.has(flag as string)
          )
        : [],
    };
  }
  return { type: "notLoaded" };
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

export function toSubagent(raw: RawThread): CodexSubagent | null {
  const threadId = asString(raw.id);
  if (!threadId) return null;
  return {
    threadId,
    parentThreadId: asString(raw.parentThreadId),
    nickname: asString(raw.agentNickname),
    role: asString(raw.agentRole),
    preview: typeof raw.preview === "string" ? raw.preview : "",
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    status: toSubagentStatus(raw.status),
    createdAt: secondsToMs(raw.createdAt),
    updatedAt: secondsToMs(raw.updatedAt),
    // Fail closed: the protocol reports `null` for unloaded threads, which is
    // every child Daintree sees, and `false` for parent-owned subagents.
    acceptsDirectInput: raw.canAcceptDirectInput === true,
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
 * Flatten a turn's items to the user/agent messages worth reading. Reasoning
 * items are dropped: they are the child's scratchpad, not its output, and they
 * dwarf the answer.
 */
export function toSubagentTurn(raw: unknown): CodexSubagentTurn | null {
  if (!raw || typeof raw !== "object") return null;
  const turn = raw as {
    id?: unknown;
    items?: unknown;
    status?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
  };
  const turnId = asString(turn.id);
  if (!turnId) return null;

  const messages: CodexSubagentMessage[] = [];
  if (Array.isArray(turn.items)) {
    for (const item of turn.items as RawTurnItem[]) {
      if (!item || typeof item !== "object") continue;
      const role =
        item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "agent" : null;
      if (!role) continue;
      const text = itemText(item).trim();
      if (!text) continue;
      messages.push({ role, text: text.slice(0, CODEX_SUBAGENT_MESSAGE_MAX_CHARS) });
    }
  }

  return {
    turnId,
    status: asString(turn.status),
    startedAt: nullableSecondsToMs(turn.startedAt),
    completedAt: nullableSecondsToMs(turn.completedAt),
    messages,
  };
}

function unavailable(
  reason: CodexSubagentUnavailableReason,
  detail?: string
): { status: "unavailable"; reason: CodexSubagentUnavailableReason; detail?: string } {
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
): Promise<ResolvedTerminal | { status: "unavailable"; reason: CodexSubagentUnavailableReason }> {
  const info = await getPtyClient().getTerminalAsync(terminalId);
  if (!info) return { status: "unavailable", reason: "terminal-unknown" };
  if (info.launchAgentId !== "codex" && info.detectedAgentId !== "codex") {
    return { status: "unavailable", reason: "not-codex" };
  }
  if (!info.cwd) return { status: "unavailable", reason: "terminal-unknown" };

  // `thread/list`'s cwd filter is an exact string match, so a path recorded
  // through a symlink (macOS `/tmp` → `/private/tmp` being the common one)
  // would match nothing. Query both spellings when they differ.
  const cwds = [info.cwd];
  try {
    const resolved = await realpath(info.cwd);
    if (resolved && resolved !== info.cwd) cwds.push(resolved);
  } catch {
    // A deleted or unreadable worktree just means the literal path is all we have.
  }

  return { cwds, spawnedAtMs: info.spawnedAt, agentSessionId: info.agentSessionId ?? null };
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
    limit: SUBAGENT_LIMIT,
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

export async function listCodexSubagents(terminalId: string): Promise<CodexSubagentsResult> {
  const resolved = await resolveTerminal(terminalId);
  if ("status" in resolved) return resolved;

  try {
    return await runCodexAppServerSession(async (call) => {
      const selection = await resolveParent(call, resolved);
      if (selection.parentThreadId === null) return unavailable(selection.reason);

      const children = await listChildren(call, selection.parentThreadId);
      return {
        status: "ok" as const,
        parentThreadId: selection.parentThreadId,
        matchedBy: selection.matchedBy,
        subagents: children
          .map(toSubagent)
          .filter((child): child is CodexSubagent => child !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt),
      };
    });
  } catch (error) {
    return toUnavailable(error);
  }
}

export async function readCodexSubagentTranscript(
  terminalId: string,
  threadId: string
): Promise<CodexSubagentTranscriptResult> {
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
      if (!children.some((child) => asString(child.id) === threadId)) {
        return unavailable("no-session");
      }

      const response = await call<{ data?: unknown }>("thread/turns/list", {
        threadId,
        limit: CODEX_SUBAGENT_TRANSCRIPT_TURN_LIMIT,
        sortDirection: "desc",
        // `summary` carries the user prompt and the agent's answer without the
        // reasoning trace. `thread/read` with `includeTurns` would also work
        // but is the deprecated full-hydration path.
        itemsView: "summary",
      });
      const turns = Array.isArray(response?.data) ? response.data : [];
      return {
        status: "ok" as const,
        threadId,
        // A turn whose only items were reasoning has nothing to show, and an
        // all-empty page would still read as "loaded" to the renderer.
        turns: turns
          .map(toSubagentTurn)
          .filter((turn): turn is CodexSubagentTurn => turn !== null && turn.messages.length > 0),
      };
    });
  } catch (error) {
    return toUnavailable(error);
  }
}
