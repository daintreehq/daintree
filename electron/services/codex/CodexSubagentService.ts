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
  type CodexSessionCandidate,
  type CodexSubagent,
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
 * A root thread created more than this long before the terminal started is a
 * different session that merely shares the folder, not this terminal's.
 * Generous because a resumed session keeps its original `createdAt`, so
 * `recencyAt` is what actually pins it — this only trims obvious strangers.
 */
const PARENT_RECENCY_WINDOW_SECONDS = 6 * 60 * 60;
/**
 * Two candidates whose activity falls inside this window of each other are
 * genuinely indistinguishable by recency, so the UI is told it is a guess.
 */
const AMBIGUITY_WINDOW_SECONDS = 60 * 60;

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

export interface ParentSelection {
  parentThreadId: string | null;
  matchedBy: "session-id" | "cwd-recency";
  candidates: CodexSessionCandidate[];
}

/**
 * Pick the root thread that most likely belongs to this terminal.
 *
 * An exact `agentSessionId` wins outright. Otherwise: keep root threads (a
 * thread with a `parentThreadId` is itself a subagent), drop any whose activity
 * predates the terminal's launch by more than the window, order by recency, and
 * take the newest. Candidates are reported whenever a second thread's activity
 * lands close enough that recency cannot separate them.
 */
export function selectParentThread(
  threads: RawThread[],
  input: { spawnedAtMs?: number; agentSessionId?: string | null }
): ParentSelection {
  if (input.agentSessionId) {
    return {
      parentThreadId: input.agentSessionId,
      matchedBy: "session-id",
      candidates: [],
    };
  }

  const spawnedAtSeconds =
    typeof input.spawnedAtMs === "number" && input.spawnedAtMs > 0
      ? Math.floor(input.spawnedAtMs / 1000)
      : null;

  const activityOf = (thread: RawThread): number => {
    const recency = thread.recencyAt;
    if (typeof recency === "number" && Number.isFinite(recency)) return recency;
    const updated = thread.updatedAt;
    if (typeof updated === "number" && Number.isFinite(updated)) return updated;
    return typeof thread.createdAt === "number" ? thread.createdAt : 0;
  };

  const roots = threads
    .filter((thread) => asString(thread.id) !== null && asString(thread.parentThreadId) === null)
    .filter((thread) => {
      if (spawnedAtSeconds === null) return true;
      return activityOf(thread) >= spawnedAtSeconds - PARENT_RECENCY_WINDOW_SECONDS;
    })
    .sort((a, b) => activityOf(b) - activityOf(a));

  const best = roots[0];
  if (!best) return { parentThreadId: null, matchedBy: "cwd-recency", candidates: [] };

  const bestActivity = activityOf(best);
  const rivals = roots.filter(
    (thread) => thread !== best && bestActivity - activityOf(thread) <= AMBIGUITY_WINDOW_SECONDS
  );

  return {
    parentThreadId: asString(best.id),
    matchedBy: "cwd-recency",
    // Only meaningful when a rival exists — an unambiguous match reports none,
    // so the renderer can treat a non-empty list as "we had to guess".
    candidates:
      rivals.length === 0
        ? []
        : [best, ...rivals].map((thread) => ({
            threadId: asString(thread.id) ?? "",
            preview: typeof thread.preview === "string" ? thread.preview : "",
            createdAt: secondsToMs(thread.createdAt),
          })),
  };
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
 * An exact session id skips the cwd query entirely — a resumed terminal was
 * launched with the thread id, so there is nothing to guess.
 */
async function resolveParent(
  call: CodexAppServerCall,
  terminal: ResolvedTerminal
): Promise<ParentSelection> {
  if (terminal.agentSessionId) return selectParentThread([], terminal);
  return selectParentThread(await listThreadsInCwd(call, terminal.cwds), terminal);
}

export async function listCodexSubagents(terminalId: string): Promise<CodexSubagentsResult> {
  const resolved = await resolveTerminal(terminalId);
  if ("status" in resolved) return resolved;

  try {
    return await runCodexAppServerSession(async (call) => {
      const selection = await resolveParent(call, resolved);
      if (!selection.parentThreadId) return unavailable("no-session");

      const children = await listChildren(call, selection.parentThreadId);
      return {
        status: "ok" as const,
        parentThreadId: selection.parentThreadId,
        matchedBy: selection.matchedBy,
        subagents: children
          .map(toSubagent)
          .filter((child): child is CodexSubagent => child !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt),
        candidates: selection.candidates,
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
      if (!selection.parentThreadId) return unavailable("no-session");

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
        turns: turns.map(toSubagentTurn).filter((turn): turn is CodexSubagentTurn => turn !== null),
      };
    });
  } catch (error) {
    return toUnavailable(error);
  }
}
