import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { schedulesClient } from "@/clients/schedulesClient";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { logError } from "@/utils/logger";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";

/**
 * - `idle`: nothing holds the names.
 * - `loading`: the first read is in flight.
 * - `ready`: `names` is the view's project's schedules as main last reported them.
 * - `failed`: the read failed, or found the view not yet showing a project; no push has
 *   answered since. The next hold reads again.
 * - `remote`: a window driving a Remote Host, which has no schedules to read.
 */
export type ScheduleNamesStatus = "idle" | "loading" | "ready" | "failed" | "remote";

interface ScheduleNamesState {
  status: ScheduleNamesStatus;
  /** Schedule id → name, for this view's project. */
  names: ReadonlyMap<string, string>;
  projectId: string | null;
  revision: number;
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

const INITIAL_STATE: ScheduleNamesState = {
  status: "idle",
  names: EMPTY_NAMES,
  projectId: null,
  revision: -1,
};

export const useScheduleNamesStore = create<ScheduleNamesState>(() => INITIAL_STATE);

// One subscription for every pane header and palette row that names a schedule,
// started by the first and dropped with the last, so a view with no scheduled
// runs never reads its schedules at all.
let holders = 0;
let unsubscribe: (() => void) | null = null;
// Bumped on every teardown, so a reply or push from an earlier hold lands nowhere.
let generation = 0;
let reading = false;

function take(snapshot: SchedulesSnapshot): void {
  const current = useScheduleNamesStore.getState();
  // A reply and a push can cross; the higher revision is the later commit.
  if (
    current.status === "ready" &&
    current.projectId === snapshot.projectId &&
    current.revision >= snapshot.revision
  ) {
    return;
  }
  useScheduleNamesStore.setState({
    status: "ready",
    names: new Map(snapshot.schedules.map((schedule) => [schedule.id, schedule.name])),
    projectId: snapshot.projectId,
    revision: snapshot.revision,
  });
}

function fail(): void {
  // Names already read stay: a failed re-read says nothing about them.
  if (useScheduleNamesStore.getState().status !== "ready") {
    useScheduleNamesStore.setState({ status: "failed" });
  }
}

function read(): void {
  if (reading) return;
  reading = true;
  const readGeneration = generation;
  // Through a promise, so a bridge that throws as it's called fails the read rather than the caller.
  Promise.resolve()
    .then(() => schedulesClient.list())
    .then((snapshot) => {
      if (readGeneration !== generation) return;
      if (snapshot) take(snapshot);
      else fail();
    })
    .catch((error: unknown) => {
      if (readGeneration !== generation) return;
      logError("Failed to read schedule names", error);
      fail();
    })
    .finally(() => {
      if (readGeneration === generation) reading = false;
    });
}

function start(): void {
  if (isRemoteWindow()) {
    useScheduleNamesStore.setState({ status: "remote" });
    return;
  }
  useScheduleNamesStore.setState({ status: "loading" });
  const pushGeneration = generation;
  // Subscribed before the read, so no commit between the two is missed.
  unsubscribe = schedulesClient.onChanged((snapshot) => {
    if (pushGeneration === generation) take(snapshot);
  });
  read();
}

function stop(): void {
  generation++;
  reading = false;
  unsubscribe?.();
  unsubscribe = null;
  useScheduleNamesStore.setState(INITIAL_STATE);
}

/** Holds the shared subscription; the returned release drops this hold once. */
export function acquireScheduleNames(): () => void {
  holders += 1;
  if (holders === 1) start();
  else retryScheduleNames();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) stop();
  };
}

/** Reads the names again if the last read failed and something still holds them. */
export function retryScheduleNames(): void {
  if (holders > 0 && useScheduleNamesStore.getState().status === "failed") read();
}

const NOT_HELD: { status: ScheduleNamesStatus; names: ReadonlyMap<string, string> } = {
  status: "idle",
  names: EMPTY_NAMES,
};

/**
 * This view's project's schedule names, read only while `enabled`: pass whether
 * anything on screen came from a schedule, so nothing is read otherwise. While
 * disabled it answers `idle` and doesn't re-render when another holder's names
 * change.
 */
export function useScheduleNames(enabled: boolean): {
  status: ScheduleNamesStatus;
  names: ReadonlyMap<string, string>;
} {
  useEffect(() => (enabled ? acquireScheduleNames() : undefined), [enabled]);
  return useScheduleNamesStore(
    useShallow((s) => (enabled ? { status: s.status, names: s.names } : NOT_HELD))
  );
}

/** How the schedule behind a run reads wherever the run is shown. */
export type ScheduleNameReading =
  | { kind: "named"; name: string }
  /** Read, and the project has no such schedule any more. */
  | { kind: "deleted" }
  /** Not read (yet, or the read failed). */
  | { kind: "unnamed" }
  /** A window driving a Remote Host, which can't show schedules. */
  | { kind: "remote" };

export function readScheduleName(
  scheduleId: string,
  status: ScheduleNamesStatus,
  names: ReadonlyMap<string, string>
): ScheduleNameReading {
  const name = names.get(scheduleId);
  if (name !== undefined) return { kind: "named", name };
  if (status === "ready") return { kind: "deleted" };
  if (status === "remote") return { kind: "remote" };
  return { kind: "unnamed" };
}

/** The words shown beside the schedule mark. */
export function scheduleNameLabel(reading: ScheduleNameReading): string {
  switch (reading.kind) {
    case "named":
      return reading.name;
    case "deleted":
      return "Deleted schedule";
    case "unnamed":
    case "remote":
      return "Scheduled run";
  }
}

export function _resetScheduleNamesForTests(): void {
  holders = 0;
  stop();
}
