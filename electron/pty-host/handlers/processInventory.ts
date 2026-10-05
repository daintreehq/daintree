import path from "node:path";
import type {
  ClosedProcessKillResult,
  ClosedProcessKillTarget,
  HostClosedTerminalProcess,
  HostProcessInventory,
  HostProcessInventoryTerminal,
  ProcessTreeSample,
} from "../../../shared/types/processes.js";
import { reapLineageEntries } from "../../services/TerminalLineageLedger.js";
import { narrowDetectedAgentId } from "./terminalInfo.js";
import type { HostContext } from "./types.js";

/** Bounds the extra-pid lookup so a malformed request cannot walk the census unbounded. */
const MAX_EXTRA_PIDS = 64;

function sampleTree(ctx: HostContext, pid: number): ProcessTreeSample | null {
  const summary = ctx.processTreeCache.getTreeResourceSummary(pid);
  if (!summary) return null;
  return {
    cpuPercent: summary.cpuPercent,
    memoryKb: summary.memoryKb,
    processCount: summary.processCount,
    // The census's `comm` can be a full executable path (macOS); the name is
    // what says what the process is, and the path is the user's filesystem.
    members: summary.breakdown.map((member) => ({
      pid: member.pid,
      comm: path.basename(member.comm) || member.comm,
      cpuPercent: member.cpuPercent,
      memoryKb: member.memoryKb,
    })),
  };
}

/**
 * Every live PTY this host owns, trashed and hidden ones included, joined with
 * its tree from the warm census — no extra OS sweep. Exited and killed records
 * kept for their scrollback are left out: nothing is running behind them.
 *
 * `extraPids` are processes Main owns (plugin children) that the census also
 * covers; they are sampled here so Main never runs a second sweep of its own.
 */
export function buildProcessInventory(
  ctx: HostContext,
  extraPids: readonly unknown[]
): HostProcessInventory {
  const terminals: HostProcessInventoryTerminal[] = [];
  for (const info of ctx.ptyManager.getAll()) {
    if (info.isExited || info.wasKilled) continue;
    const pid = info.ptyProcess?.pid;
    const rootPid = Number.isInteger(pid) && (pid as number) > 0 ? (pid as number) : null;
    const isTrashed = ctx.ptyManager.isInTrash(info.id);
    // The bulk record never carries the expiry; only the registry knows it.
    const trashExpiresAt = isTrashed
      ? ctx.ptyManager.getTerminal(info.id)?.trashExpiresAt
      : undefined;
    terminals.push({
      id: info.id,
      projectId: info.projectId ?? null,
      kind: info.kind,
      title: info.title,
      cwd: info.cwd,
      worktreeId: info.worktreeId,
      launchAgentId: info.launchAgentId,
      detectedAgentId: narrowDetectedAgentId(info.detectedAgentId),
      isAssistantTerminal: info.isAssistantTerminal === true,
      spawnedAt: info.spawnedAt,
      isTrashed,
      trashExpiresAt,
      rootPid,
      sample: rootPid === null ? null : sampleTree(ctx, rootPid),
    });
  }

  const pidSamples: Record<number, ProcessTreeSample> = {};
  for (const pid of extraPids.slice(0, MAX_EXTRA_PIDS)) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    const sample = sampleTree(ctx, pid);
    if (sample) pidSamples[pid] = sample;
  }

  return {
    terminals,
    closedTerminalProcesses: listClosedTerminalProcesses(ctx),
    pidSamples,
    available: ctx.processTreeCache.getLastError() === null,
    sampledAt: ctx.processTreeCache.getLastRefreshTime(),
  };
}

/** Bounds what one inventory carries, so a runaway fork bomb can't bloat the reply. */
const MAX_CLOSED_PROCESSES = 256;

/**
 * Descendants the ledger still holds under roots that closed past the grace
 * window, joined with the warm census for name and memory. The ledger keeps
 * its entries through a failed census, so these remain listed — the
 * inventory's `available` flag is what says the reading is old.
 */
export function listClosedTerminalProcesses(ctx: HostContext): HostClosedTerminalProcess[] {
  const ledger = ctx.lineageLedger;
  if (!ledger) return [];
  const out: HostClosedTerminalProcess[] = [];
  for (const survivor of ledger.getClosedSurvivors()) {
    if (out.length >= MAX_CLOSED_PROCESSES) break;
    const proc = ctx.processTreeCache.getProcess(survivor.pid);
    out.push({
      pid: survivor.pid,
      startTime: survivor.startTime,
      comm: proc ? path.basename(proc.comm) || proc.comm : "",
      memoryKb: proc ? proc.rssKb : null,
      cpuPercent: proc ? proc.cpuPercent : null,
      origin: survivor.origin,
      closedAt: survivor.closedAtMs,
    });
  }
  return out;
}

/** Caps one request; the UI asks for a single closed terminal's processes. */
const MAX_KILL_TARGETS = 256;

/**
 * End closed-terminal processes a renderer named. Ownership is this host's
 * own record, never the request: a target is signalled only when the ledger
 * holds that exact pid and start time under a closed root, and the reap
 * re-verifies the start time against the OS before every signal.
 */
export async function killClosedTerminalProcesses(
  ctx: HostContext,
  targets: readonly unknown[]
): Promise<ClosedProcessKillResult> {
  const result: ClosedProcessKillResult = { ended: 0, stillRunning: 0, unchecked: 0, notTracked: 0 };
  const ledger = ctx.lineageLedger;
  const wanted = new Set<string>();
  for (const raw of targets.slice(0, MAX_KILL_TARGETS)) {
    const target = raw as Partial<ClosedProcessKillTarget> | null;
    if (
      !target ||
      typeof target.pid !== "number" ||
      !Number.isInteger(target.pid) ||
      target.pid <= 1 ||
      typeof target.startTime !== "string"
    ) {
      continue;
    }
    wanted.add(`${target.pid}@${target.startTime}`);
  }
  if (!ledger) {
    result.notTracked = wanted.size;
    return result;
  }
  // No grace here: the user is looking at a row the inventory already listed.
  const owned = ledger
    .getClosedSurvivors(0)
    .filter((survivor) => wanted.has(`${survivor.pid}@${survivor.startTime}`));
  result.notTracked = wanted.size - owned.length;
  if (owned.length === 0) return result;

  const outcome = await reapLineageEntries(
    owned.map(({ pid, startTime, rootPid }) => ({ pid, startTime, rootPid })),
    { reason: "from closed terminals at the user's request", windowsTree: false }
  );
  // A target the first probe already found gone, or under another start time,
  // ended before we signalled it — the same observation as one that ended after.
  result.ended = owned.length - outcome.stillRunning - outcome.unchecked;
  result.stillRunning = outcome.stillRunning;
  result.unchecked = outcome.unchecked;
  return result;
}
