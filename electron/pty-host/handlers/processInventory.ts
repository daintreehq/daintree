import path from "node:path";
import type {
  HostProcessInventory,
  HostProcessInventoryTerminal,
  ProcessTreeSample,
} from "../../../shared/types/processes.js";
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
    pidSamples,
    available: ctx.processTreeCache.getLastError() === null,
    sampledAt: ctx.processTreeCache.getLastRefreshTime(),
  };
}
