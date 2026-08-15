import type {
  FleetSnapshot,
  RunParkRecord,
  RunSnoozeRecord,
} from "../../../shared/types/ipc/fleet.js";
import {
  isAgentSnoozeDurationOption,
  type AgentSnoozeDurationOption,
} from "../../../shared/utils/agentSnoozeDurations.js";
import { getFleetSnapshotService, getRunAttentionService } from "./projectCrud/index.js";
import { MAX_PARK_NOTE_LENGTH } from "../../services/RunAttentionService.js";
import { checkRateLimit } from "../utils.js";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { FLEET_METHOD_CHANNELS } from "./fleet.preload.js";

/**
 * Renderer input is untrusted: ids are bounded strings, and the options bag
 * must actually be a plain object — `null`, arrays and primitives are rejected
 * rather than treated as "no options", so a type-confused caller hears about
 * it instead of silently parking with defaults it didn't choose.
 */
function assertRunId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`Invalid ${what}`);
  }
}

/**
 * Both ids must name runs the fleet can currently see. This is what makes a
 * park addressable and a gate releasable: an id the snapshot doesn't know is
 * either hostile, mistyped, or already trashed — and a gate that was trashed
 * before the park existed would otherwise never fire its gate-closed release,
 * hiding the run forever. The check requires a healthy snapshot on purpose;
 * while the fleet is unreadable the park surfaces can't be trusted either.
 * (A gate trashed in the instant between this check and the service commit
 * still slips through — the 14-day expiry and manual unpark bound that gap.)
 */
function assertKnownRuns(runId: string, gateRunId: string | undefined): void {
  const snapshot = getFleetSnapshotService()?.getLastBroadcast();
  if (!snapshot || snapshot.degraded) {
    throw new Error("Fleet state is unavailable right now — try again in a moment");
  }
  const known = new Set(snapshot.runs.map((run) => run.runId));
  if (!known.has(runId)) throw new Error("Run not found in the current fleet");
  if (gateRunId !== undefined && !known.has(gateRunId)) {
    throw new Error("Gate terminal not found in the current fleet");
  }
}

export const fleetNamespace = defineIpcNamespace({
  name: "fleet",
  ops: {
    /**
     * Pull the current fleet snapshot.
     *
     * The push path alone cannot hydrate a view. `pushSnapshotTo` fires at
     * `did-finish-load`, but a renderer subscribes from a React effect that
     * runs later, and Electron does not buffer a direct send — so the replay
     * can be dropped. Every subsequent poll then compares equal and is
     * suppressed, leaving that V8 context with no snapshot until the fleet
     * happens to change. Waiting, blocked and awaiting-review are exactly the
     * states that stop changing, so the fleet most worth seeing is the one
     * most likely to never arrive.
     *
     * Mirrors how `ProjectStatsService` is hydrated by the palette's bulk-stats
     * pull: push keeps a live view current, this makes a cold one correct.
     *
     * Returns null when nothing has been computed yet, which the renderer must
     * keep distinct from an empty fleet — only the latter may render as clear.
     */
    getSnapshot: op(
      FLEET_METHOD_CHANNELS.getSnapshot,
      async (): Promise<FleetSnapshot | null> =>
        getFleetSnapshotService()?.getLastBroadcast() ?? null
    ),

    /**
     * Park a run — record that it doesn't need the user, optionally until the
     * gate terminal next comes free. Reversible in one keystroke and local to
     * attention surfaces (D0), so no confirmation tier applies.
     *
     * The note length check here is a size guard against a hostile payload;
     * the exact semantics (trim, cap at {@link MAX_PARK_NOTE_LENGTH} UTF-16
     * code units, surrogate tidy-up) belong to the service, which is the one
     * authority on what a stored note looks like.
     */
    parkRun: op(
      FLEET_METHOD_CHANNELS.parkRun,
      async (
        runId: string,
        options?: { note?: string; gateRunId?: string }
      ): Promise<RunParkRecord> => {
        checkRateLimit(CHANNELS.FLEET_PARK_RUN, 20, 10_000);
        assertRunId(runId, "run id");
        if (options !== undefined) {
          if (typeof options !== "object" || options === null || Array.isArray(options)) {
            throw new Error("Invalid park options");
          }
        }
        const note = options?.note;
        if (
          note !== undefined &&
          (typeof note !== "string" || note.length > MAX_PARK_NOTE_LENGTH * 4)
        ) {
          throw new Error("Invalid park note");
        }
        const gateRunId = options?.gateRunId;
        if (gateRunId !== undefined) assertRunId(gateRunId, "gate run id");
        assertKnownRuns(runId, gateRunId);

        const service = getRunAttentionService();
        if (!service) throw new Error("Run attention service unavailable");
        return service.park(runId, {
          ...(note !== undefined ? { note } : {}),
          ...(gateRunId !== undefined ? { gateRunId } : {}),
        });
      }
    ),

    /**
     * Lift a park by hand. Resolves false when the run wasn't parked. No
     * snapshot check: removing a record is safe whether or not the fleet is
     * currently readable, and blocking the way OUT of a park on host health
     * would hide runs behind a degradation the user can't fix.
     */
    unparkRun: op(FLEET_METHOD_CHANNELS.unparkRun, async (runId: string): Promise<boolean> => {
      checkRateLimit(CHANNELS.FLEET_UNPARK_RUN, 20, 10_000);
      assertRunId(runId, "run id");
      const service = getRunAttentionService();
      if (!service) throw new Error("Run attention service unavailable");
      return service.unpark(runId);
    }),

    /**
     * Snooze a run — drop it out of the project's attention roll-up until the
     * chosen ceiling passes or the user types at it. Reversible in one
     * keystroke and local to attention surfaces (D0), so no confirmation tier
     * applies.
     *
     * The duration is validated as a member of the ladder rather than accepted
     * as a raw number of milliseconds: an arbitrary expiry from the renderer
     * would be a wake time no menu could ever show, and the four options are
     * the whole product surface.
     */
    snoozeRun: op(
      FLEET_METHOD_CHANNELS.snoozeRun,
      async (runId: string, option: AgentSnoozeDurationOption): Promise<RunSnoozeRecord> => {
        checkRateLimit(CHANNELS.FLEET_SNOOZE_RUN, 20, 10_000);
        assertRunId(runId, "run id");
        if (!isAgentSnoozeDurationOption(option)) {
          throw new Error("Invalid snooze duration");
        }
        // Same liveness requirement parking has: a run the snapshot cannot see
        // is hostile, mistyped or already gone, and snoozing it would persist
        // intent against an id nothing will ever clear.
        assertKnownRuns(runId, undefined);

        const service = getRunAttentionService();
        if (!service) throw new Error("Run attention service unavailable");
        return service.snooze(runId, option);
      }
    ),

    /**
     * Lift a snooze by hand. Resolves false when the run wasn't snoozed. No
     * snapshot check, for the same reason unpark has none: the way OUT of a
     * suppression must not depend on the fleet being readable.
     */
    unsnoozeRun: op(FLEET_METHOD_CHANNELS.unsnoozeRun, async (runId: string): Promise<boolean> => {
      checkRateLimit(CHANNELS.FLEET_UNSNOOZE_RUN, 20, 10_000);
      assertRunId(runId, "run id");
      const service = getRunAttentionService();
      if (!service) throw new Error("Run attention service unavailable");
      return service.unsnooze(runId);
    }),
  },
});

export function registerFleetHandlers(): () => void {
  return fleetNamespace.register();
}
