import type { FleetSnapshot } from "@shared/types/ipc/fleet";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";

export type BulkParkVerb = "park" | "unpark";

/**
 * Mirrors main's limit on `fleet:park-run` / `fleet:unpark-run` (20 calls per
 * rolling 10s). There is no batch channel, so a worktree with more agents than
 * that is paced here rather than left to fail past the 20th.
 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_CALLS = 20;

/**
 * Call times per channel, shared by every bulk run in this renderer: main's
 * budget is per channel, not per request, so two worktrees parked back to back
 * — or a Retry straight after a failure — draw on the same window.
 */
const callTimesByVerb: Record<BulkParkVerb, number[]> = { park: [], unpark: [] };

/** Test seam: forget the shared pacing window. */
export function resetBulkParkPacing(): void {
  callTimesByVerb.park = [];
  callTimesByVerb.unpark = [];
}

function needsVerb(snapshot: FleetSnapshot | null, runId: string, verb: BulkParkVerb): boolean {
  const run = snapshot?.runs.find((r) => r.runId === runId);
  if (run === undefined) return false;
  // Main rejects a park over retained data; an unpark needs no healthy view.
  if (verb === "park" && snapshot?.degraded) return false;
  return verb === "park" ? run.park === undefined : run.park !== undefined;
}

/**
 * The runs among `terminalIds` the verb would change: unparked agents for
 * Park, parked ones for Unpark. Joined by id against the snapshot, so plain
 * shells (never on it) and runs it can't see drop out — the same set the
 * handler would accept. Park leaves an existing park alone rather than
 * replacing its note and release with a bare manual one.
 */
export function selectParkTargets(
  snapshot: FleetSnapshot | null,
  terminalIds: readonly string[],
  verb: BulkParkVerb
): string[] {
  return terminalIds.filter((id) => needsVerb(snapshot, id, verb));
}

export interface BulkParkDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BulkParkResult {
  succeeded: number;
  failed: string[];
  firstError: unknown;
}

/**
 * Apply the verb to each run in turn, paced under main's rate limit. Each run
 * is re-checked against the live snapshot just before its call: a run that
 * closed, or that the user parked or unparked by hand meanwhile, is skipped
 * rather than failed.
 */
export async function runBulkPark(
  verb: BulkParkVerb,
  runIds: readonly string[],
  deps: BulkParkDeps = {}
): Promise<BulkParkResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const callTimes = callTimesByVerb[verb];
  const failed: string[] = [];
  let firstError: unknown = undefined;
  let succeeded = 0;

  for (const runId of runIds) {
    // A loop, not a single wait: a concurrent run can take the freed slot
    // while this one sleeps.
    while (callTimes.length >= RATE_MAX_CALLS) {
      const wait = callTimes[callTimes.length - RATE_MAX_CALLS]! + RATE_WINDOW_MS - now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    if (!needsVerb(useFleetSnapshotStore.getState().snapshot, runId, verb)) continue;
    callTimes.push(now());
    // Only the last window's worth matters for the next wait.
    if (callTimes.length > RATE_MAX_CALLS) callTimes.splice(0, callTimes.length - RATE_MAX_CALLS);
    try {
      if (verb === "park") {
        await window.electron.fleet.parkRun(runId, {});
      } else {
        await window.electron.fleet.unparkRun(runId);
      }
      succeeded++;
    } catch (error) {
      failed.push(runId);
      if (firstError === undefined) firstError = error;
    }
  }
  return { succeeded, failed, firstError };
}

/**
 * Park or unpark every agent in a worktree in one step. No confirmation:
 * parking is local and reversible, and the inverse sits beside it in the same
 * menu. Success is visible on the rows themselves, so only a failure speaks —
 * once, with a retry scoped to the runs that didn't take.
 */
export async function bulkParkAgents(
  verb: BulkParkVerb,
  runIds: readonly string[],
  context: { worktreeId?: string } = {},
  deps?: BulkParkDeps
): Promise<void> {
  if (runIds.length === 0) return;
  const { failed, firstError } = await runBulkPark(verb, runIds, deps);
  if (failed.length === 0) return;

  const verbText = verb === "park" ? "park" : "unpark";
  notify({
    type: "error",
    // `uiFeedback` alone resolves to inbox-only, which would hide the retry.
    priority: "high",
    context: { eventKind: "uiFeedback", ...context },
    title: `Couldn't ${verbText} ${pluralize(failed.length, "agent")}`,
    message: formatErrorMessage(firstError, `The ${verbText} request was rejected.`),
    action: {
      label: "Retry",
      onClick: () => bulkParkAgents(verb, failed, context, deps),
    },
  });
}
