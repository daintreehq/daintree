import { describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduledRun } from "../../../../shared/types/scheduledRuns.js";
import { SCHEDULED_RUN_INBOX_LEASE_MS, ScheduledRunInbox } from "../ScheduledRunInbox.js";

function run(id: string, scheduleId = "schedule-1"): ScheduledRun {
  return { id, scheduleId, projectId: "project-1" } as ScheduledRun;
}

function setup(pending: ScheduledRun[]) {
  let now = 1_000;
  const live = new Set([1, 2]);
  const shown = new Set([1, 2]);
  const waiting = [...pending];
  const recorder = {
    listInboxPending: vi.fn(() => [...waiting]),
    clearInboxPending: vi.fn((ids: readonly string[]) => {
      const cleared = waiting.filter((r) => ids.includes(r.id)).map((r) => r.id);
      for (const id of cleared)
        waiting.splice(
          waiting.findIndex((r) => r.id === id),
          1
        );
      return cleared;
    }),
  };
  const getSchedule = vi.fn(
    async (_projectId: string, scheduleId: string) =>
      ({ name: `Name of ${scheduleId}`, cadence: { timeZone: "Asia/Tokyo" } }) as Schedule
  );
  const inbox = new ScheduledRunInbox({
    recorder: async () => recorder,
    getSchedule,
    isLive: (id) => live.has(id),
    isShown: (id) => shown.has(id),
    now: () => now,
    logWarn: () => {},
  });
  return {
    inbox,
    recorder,
    getSchedule,
    live,
    shown,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ids = (take: { items: Array<{ run: ScheduledRun }> }) =>
  take.items.map((item) => item.run.id);
const none = { items: [], retryInMs: null };

describe("ScheduledRunInbox", () => {
  it("hands each waiting run to one view at a time, with its schedule read once", async () => {
    const { inbox, getSchedule } = setup([run("a"), run("b"), run("c", "schedule-2")]);

    const first = await inbox.take(1);
    expect(ids(first)).toEqual(["a", "b", "c"]);
    expect(first.items[0]?.schedule).toEqual({
      name: "Name of schedule-1",
      timeZone: "Asia/Tokyo",
    });
    expect(first.retryInMs).toBeNull();
    expect(getSchedule).toHaveBeenCalledTimes(2);

    // The other view is told when the hold lapses, to ask again then.
    expect(await inbox.take(2)).toEqual({ items: [], retryInMs: SCHEDULED_RUN_INBOX_LEASE_MS });
  });

  it("hands nothing to a view no window shows, and holds nothing for it", async () => {
    const { inbox, shown } = setup([run("a")]);
    shown.delete(2);
    expect(await inbox.take(2)).toEqual(none);
    expect(ids(await inbox.take(1))).toEqual(["a"]);
  });

  it("hands them to the same view again when it asks again, as a reloaded view does", async () => {
    const { inbox } = setup([run("a")]);
    await inbox.take(1);
    expect(ids(await inbox.take(1))).toEqual(["a"]);
  });

  it("lets another view take them once the holder is gone or has kept quiet too long", async () => {
    const { inbox, live, advance } = setup([run("a"), run("b")]);
    await inbox.take(1);

    live.delete(1);
    expect(ids(await inbox.take(2))).toEqual(["a", "b"]);

    advance(SCHEDULED_RUN_INBOX_LEASE_MS - 1);
    expect(await inbox.take(1)).toEqual({ items: [], retryInMs: 1 });
    advance(1);
    expect(ids(await inbox.take(1))).toEqual(["a", "b"]);
  });

  it("clears what a view acks, so no view is handed it again", async () => {
    const { inbox, recorder } = setup([run("a"), run("b")]);
    await inbox.take(1);

    expect(await inbox.ack(["a"])).toEqual(["a"]);
    expect(recorder.clearInboxPending).toHaveBeenCalledWith(["a"]);
    expect(ids(await inbox.take(1))).toEqual(["b"]);
    expect(ids(await inbox.take(2))).toEqual([]);
  });

  it("hands a run over without its schedule when the schedule can't be read", async () => {
    const { inbox, getSchedule } = setup([run("a")]);
    getSchedule.mockRejectedValueOnce(new Error("disk"));

    expect((await inbox.take(1)).items).toEqual([{ run: run("a"), schedule: null }]);
  });

  it("holds the runs before reading schedules, so a view asking meanwhile gets none", async () => {
    const { inbox, getSchedule } = setup([run("a")]);
    let release!: () => void;
    getSchedule.mockImplementationOnce(
      () =>
        new Promise<Schedule>((resolve) => {
          release = () => resolve({ name: "Late", cadence: { timeZone: "UTC" } } as Schedule);
        })
    );

    const first = inbox.take(1);
    await vi.waitFor(() => expect(getSchedule).toHaveBeenCalled());
    expect(ids(await inbox.take(2))).toEqual([]);
    release();
    expect(ids(await first)).toEqual(["a"]);
  });

  it("hands nothing over when the history isn't there", async () => {
    const inbox = new ScheduledRunInbox({
      recorder: async () => null,
      getSchedule: vi.fn(),
      isLive: () => true,
      isShown: () => true,
    });
    expect(await inbox.take(1)).toEqual(none);
    expect(await inbox.ack(["a"])).toEqual([]);
  });
});
