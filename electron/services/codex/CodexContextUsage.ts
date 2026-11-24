/**
 * The host's half of a Codex pane's context reading (#16408).
 *
 * The renderer names a terminal and nothing else. The rollout is the one the
 * pane's own Codex process holds open for writing, found the way a plugin's
 * session-file lookup finds it (#16097), so it answers for any `CODEX_HOME`
 * and for a `codex` typed into a shell, and reads nothing when that file can't
 * be told apart with certainty. Over a remote link this runs on the host, so a
 * remote pane is read where its rollout is.
 */

import type { AgentSessionFileUnknownReason } from "../../../shared/types/agentSessionFile.js";
import type {
  AgentContextUsageResult,
  AgentContextUsageUnavailableReason,
} from "../../../shared/types/ipc/agentContextUsage.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { createContextUsageLanes } from "../contextUsageLanes.js";
import type { PtyClient } from "../PtyClient.js";
import { subagentTerminalAgentId } from "../subagentTerminalAgent.js";
import { readCodexContextUsage } from "./CodexRolloutReader.js";
import { observeCodexRollout, type CodexRolloutObservation } from "./CodexSessionFileProbe.js";

/**
 * A reading that hasn't answered by now answers that the rollout couldn't be
 * read. The probe's listings are each bounded and together stay inside it, so
 * only a stalled filesystem gets here.
 */
export const CODEX_CONTEXT_USAGE_HOST_DEADLINE_MS = 5_000;

/**
 * How long a probe that found no rollout answers for the same run of a pane,
 * from when it answered. A turn's two reads come 1.5 s apart, and each would
 * otherwise list the pane's processes and files again to find nothing (#17044).
 */
export const CODEX_PROBE_MISS_REUSE_MS = 3_000;

/**
 * Misses that a second listing a moment later would repeat. `pane-changed` is
 * not one: the process was replaced mid-listing, and its successor is worth a
 * look. A rollout found is never reused either, because after `/clear` the old
 * one is still on disk under the same identity, and only a fresh listing shows
 * that Codex has moved on to another.
 */
const REUSABLE_MISSES: ReadonlySet<AgentSessionFileUnknownReason> = new Set([
  "not-observed",
  "unverified",
  "ambiguous",
  "probe-failed",
]);

type TerminalQueries = Pick<PtyClient, "getTerminalAsync" | "getTerminalInfo">;
type TerminalRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

/** One probe per run of a pane at a time, and its miss for a moment after. */
export interface CodexProbeMemo {
  observe(
    terminalId: string,
    run: string,
    probe: () => Promise<CodexRolloutObservation>
  ): Promise<CodexRolloutObservation>;
}

interface ProbeEntry {
  run: string;
  probe: Promise<CodexRolloutObservation>;
  /** When a reusable miss answered; null while the probe runs. */
  missedAt: number | null;
}

/** Nothing runs between reads: expired misses are dropped by the next one. */
export function createCodexProbeMemo(now: () => number = () => performance.now()): CodexProbeMemo {
  const entries = new Map<string, ProbeEntry>();
  return {
    observe(terminalId, run, probe) {
      const at = now();
      for (const [id, entry] of entries) {
        if (entry.missedAt !== null && at - entry.missedAt >= CODEX_PROBE_MISS_REUSE_MS) {
          entries.delete(id);
        }
      }
      const current = entries.get(terminalId);
      if (current?.run === run) return current.probe;

      const entry: ProbeEntry = { run, probe: Promise.resolve().then(probe), missedAt: null };
      // A probe for a run since replaced settles without touching its successor's entry.
      const forget = () => {
        if (entries.get(terminalId) === entry) entries.delete(terminalId);
      };
      entry.probe.then((observed) => {
        if (observed.status === "unknown" && REUSABLE_MISSES.has(observed.reason)) {
          if (entries.get(terminalId) === entry) entry.missedAt = now();
        } else {
          forget();
        }
      }, forget);
      entries.set(terminalId, entry);
      return entry.probe;
    },
  };
}

const probes = createCodexProbeMemo();

export interface CodexContextUsageDeps {
  ptyClient?: TerminalQueries | null;
  platform?: NodeJS.Platform;
  observe?: typeof observeCodexRollout;
  read?: typeof readCodexContextUsage;
  probes?: CodexProbeMemo;
}

function unavailable(reason: AgentContextUsageUnavailableReason): AgentContextUsageResult {
  return { status: "unavailable", reason };
}

function fromProbe(reason: AgentSessionFileUnknownReason): AgentContextUsageUnavailableReason {
  switch (reason) {
    case "unsupported-platform":
    case "probe-failed":
    case "pane-changed":
      return reason;
    case "no-live-agent":
      return "terminal-unknown";
    default:
      return "rollout-unknown";
  }
}

/** The same run, still running Codex: the reading still describes the pane. */
function sameRun(before: TerminalRecord, after: TerminalRecord | null): boolean {
  return (
    after !== null &&
    after.spawnedAt === before.spawnedAt &&
    after.launchGeneration === before.launchGeneration &&
    after.agentIncarnation === before.agentIncarnation &&
    after.agentSessionId === before.agentSessionId &&
    subagentTerminalAgentId(after) === "codex"
  );
}

export async function readCodexPaneContextUsage(
  terminalId: string,
  signal: AbortSignal,
  deps: CodexContextUsageDeps = {}
): Promise<AgentContextUsageResult> {
  signal.throwIfAborted();
  const queries = deps.ptyClient === undefined ? getPtyClient() : deps.ptyClient;
  if (!queries) return unavailable("terminal-unknown");
  const record = await queries.getTerminalAsync(terminalId);
  if (!record) return unavailable("terminal-unknown");
  // An exited agent answers for nothing, though the record keeps its launch hint.
  if (subagentTerminalAgentId(record) !== "codex") return unavailable("provider-mismatch");
  if ((deps.platform ?? process.platform) === "win32") return unavailable("unsupported-platform");

  // The process id is only on the diagnostic read. It may be a shell that
  // started `codex`, so the probe walks everything under it.
  const info = await queries.getTerminalInfo(terminalId);
  if (!info) return unavailable("terminal-unknown");
  if (info.spawnedAt !== record.spawnedAt || info.agentIncarnation !== record.agentIncarnation) {
    return unavailable("pane-changed");
  }
  if (info.hasPty !== true || typeof info.ptyPid !== "number") {
    return unavailable("provider-mismatch");
  }
  signal.throwIfAborted();
  const { ptyPid } = info;
  const run = JSON.stringify([
    ptyPid,
    record.spawnedAt,
    record.launchGeneration,
    record.agentIncarnation,
    record.agentSessionId ?? null,
  ]);
  const observed = await (deps.probes ?? probes).observe(terminalId, run, () =>
    (deps.observe ?? observeCodexRollout)(ptyPid)
  );
  if (observed.status !== "observed") return unavailable(fromProbe(observed.reason));
  signal.throwIfAborted();

  const result = await (deps.read ?? readCodexContextUsage)(observed, { signal });
  if (result.status !== "ok") return result;
  const after = await queries.getTerminalAsync(terminalId);
  return sameRun(record, after) ? result : unavailable("pane-changed");
}

const lanes = createContextUsageLanes();

/**
 * {@link readCodexPaneContextUsage} in the terminal's lane, with a deadline
 * that holds whether or not the filesystem honours the abort.
 */
export async function readCodexPaneContextUsageWithin(
  terminalId: string,
  deps: CodexContextUsageDeps & { deadlineMs?: number } = {}
): Promise<AgentContextUsageResult> {
  return lanes.run(terminalId, deps.deadlineMs ?? CODEX_CONTEXT_USAGE_HOST_DEADLINE_MS, (signal) =>
    readCodexPaneContextUsage(terminalId, signal, deps)
  );
}

/** Test-only: how many callers are waiting behind a terminal's running read. */
export function __codexContextUsageWaiters(terminalId: string): number {
  return lanes.waiters(terminalId);
}
