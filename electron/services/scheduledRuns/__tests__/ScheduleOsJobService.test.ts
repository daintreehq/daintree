import { describe, expect, it, vi } from "vitest";
import { createSchedule } from "../../../../shared/utils/scheduledRuns.js";
import type { Schedule } from "../../../../shared/types/scheduledRuns.js";
import type { SchedulesSnapshot } from "../../../../shared/types/ipc/schedules.js";
import type { ScheduleOsJobContext } from "../../../../shared/utils/scheduleOsJob.js";
import {
  ScheduleOsJobService,
  type ScheduleOsJobAdapter,
  type ScheduleOsJobObservation,
} from "../ScheduleOsJobService.js";

const ZONE = "Europe/London";
const MAC: ScheduleOsJobContext = { kind: "launch-agent", systemTimeZone: ZONE };

function schedule(
  id: string,
  projectId: string,
  options: {
    cron?: string;
    timeZone?: string;
    enabled?: boolean;
    runWhenClosed?: boolean;
  } = {}
): Schedule {
  return createSchedule(
    {
      id,
      projectId,
      name: id,
      launch: { agentId: "claude", prompt: "Go." },
      cron: options.cron ?? "0 9 * * *",
      timeZone: options.timeZone ?? ZONE,
      enabled: options.enabled ?? true,
      policies: { runWhenClosed: options.runWhenClosed ?? true },
    },
    1
  );
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records what each sync was asked for, and reads current when the last one is what's wanted. */
function fakeAdapter(options: { unavailable?: string | null } = {}) {
  const syncs: { crons: string[]; reload: boolean }[] = [];
  const zones: string[] = [];
  const events: string[] = [];
  let installed: string[] | null = null;
  let unloaded = false;
  let gate: Promise<void> | null = null;
  let failure: Error | null = null;
  const crons = (cadences: readonly { cron: string }[]) =>
    cadences.map((cadence) => cadence.cron).sort();
  const adapter: ScheduleOsJobAdapter = {
    kind: "launch-agent",
    unavailable: options.unavailable ?? null,
    sync: vi.fn(async (cadences, zone, { reload }) => {
      syncs.push({ crons: crons(cadences), reload });
      zones.push(zone);
      if (gate) await gate;
      events.push("synced");
      if (failure) throw failure;
      installed = cadences.length > 0 ? crons(cadences) : null;
      unloaded = false;
    }),
    observe: vi.fn(async (cadences): Promise<ScheduleOsJobObservation> => {
      const wanted = cadences.length > 0 ? crons(cadences) : null;
      return {
        installed: installed !== null,
        current: JSON.stringify(installed) === JSON.stringify(wanted),
        loaded: installed !== null && !unloaded,
      };
    }),
  };
  return {
    adapter,
    syncs,
    zones,
    events,
    /** launchd dropped the job; its file still reads current. */
    unload: () => {
      unloaded = true;
    },
    hold: () => {
      const held = deferred();
      gate = held.promise;
      return () => {
        gate = null;
        held.resolve();
      };
    },
    fail: (error: Error | null) => {
      failure = error;
    },
    drift: () => {
      installed = ["drifted"];
    },
  };
}

function fakeStore(initial: Record<string, Schedule[]>) {
  let revision = 0;
  const current = new Map(Object.entries(initial));
  const listeners = new Set<(snapshot: SchedulesSnapshot) => void>();
  const failing = new Set<string>();
  const list = vi.fn(async (projectId: string): Promise<SchedulesSnapshot> => {
    if (failing.has(projectId)) throw new Error("EACCES");
    return { projectId, schedules: current.get(projectId) ?? [], revision };
  });
  return {
    listProjectIds: () => [...current.keys()],
    list,
    subscribe: (listener: (snapshot: SchedulesSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit(projectId: string, schedules: Schedule[]) {
      revision += 1;
      current.set(projectId, schedules);
      for (const listener of listeners) listener({ projectId, schedules, revision });
    },
    failReads(projectId: string, fails: boolean) {
      if (fails) failing.add(projectId);
      else failing.delete(projectId);
    },
    listenerCount: () => listeners.size,
  };
}

function service(
  store: ReturnType<typeof fakeStore>,
  adapter: ScheduleOsJobAdapter,
  context: () => ScheduleOsJobContext = () => MAC
) {
  return new ScheduleOsJobService({
    adapter,
    listProjectIds: store.listProjectIds,
    listSchedules: store.list,
    subscribeSchedules: store.subscribe,
    context,
    readTimeoutMs: 1_000,
    drainTimeoutMs: 1_000,
  });
}

describe("ScheduleOsJobService", () => {
  it("writes one job for the switched-on, opted-in schedules of every project", async () => {
    const store = fakeStore({
      a: [
        schedule("a1", "a"),
        schedule("a2", "a", { cron: "0 7 * * *", runWhenClosed: false }),
        schedule("a3", "a", { cron: "0 8 * * *", enabled: false }),
      ],
      b: [
        schedule("b1", "b", { cron: "30 * * * *" }),
        schedule("b2", "b", { cron: "0 6 * * *", timeZone: "Asia/Tokyo" }),
      ],
    });
    const job = fakeAdapter();
    await service(store, job.adapter).start();

    expect(job.syncs).toEqual([{ crons: ["0 9 * * *", "30 * * * *"], reload: false }]);
    expect(vi.mocked(job.adapter.sync).mock.calls[0]).toEqual([
      [
        { cron: "0 9 * * *", timeZone: ZONE },
        { cron: "30 * * * *", timeZone: ZONE },
      ],
      ZONE,
      { reload: false },
    ]);
  });

  it("rewrites the job after each change, and removes it when none is left", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    await svc.start();

    store.commit("a", [schedule("a1", "a"), schedule("a2", "a", { cron: "0 18 * * *" })]);
    await svc.status("a");
    store.commit("a", [schedule("a1", "a", { enabled: false })]);
    await svc.status("a");

    expect(job.syncs.map((sync) => sync.crons)).toEqual([
      ["0 9 * * *"],
      ["0 18 * * *", "0 9 * * *"],
      [],
    ]);
  });

  it("takes changes that arrive during a pass in one more pass, from the newest", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    const release = job.hold();
    const started = svc.start();
    await vi.waitFor(() => expect(job.syncs).toHaveLength(1));

    store.commit("a", [schedule("a1", "a", { cron: "0 10 * * *" })]);
    store.commit("a", [schedule("a1", "a", { cron: "0 11 * * *" })]);
    store.commit("b", [schedule("b1", "b", { cron: "0 12 * * *" })]);
    release();
    await started;
    await svc.status("a");

    expect(job.syncs.map((sync) => sync.crons)).toEqual([
      ["0 9 * * *"],
      ["0 11 * * *", "0 12 * * *"],
    ]);
  });

  it("keeps a change committed while the first reads are out", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const read = deferred<SchedulesSnapshot>();
    store.list.mockImplementationOnce(() => read.promise);
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    const started = svc.start();

    store.commit("a", []);
    read.resolve({ projectId: "a", schedules: [schedule("a1", "a")], revision: 0 });
    await started;

    expect(job.syncs).toEqual([{ crons: [], reload: false }]);
  });

  it("leaves the job as it was while a project's schedules can't be read", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")], b: [] });
    store.failReads("b", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    await svc.start();

    expect(job.syncs).toEqual([]);
    expect(await svc.status("a")).toMatchObject({
      state: "stale",
      error: expect.stringMatching(/every project/),
    });

    store.failReads("b", false);
    expect(await svc.status("a")).toMatchObject({ state: "current", error: null });
    expect(job.syncs).toEqual([{ crons: ["0 9 * * *"], reload: false }]);
    warn.mockRestore();
  });

  it("leaves the job as it was while the Mac's zone can't be read", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    let context: ScheduleOsJobContext = { kind: "launch-agent", systemTimeZone: null };
    const svc = service(store, job.adapter, () => context);
    await svc.start();

    expect(job.syncs).toEqual([]);
    expect(await svc.status("a")).toMatchObject({ state: "stale", error: expect.any(String) });

    context = MAC;
    expect(await svc.status("a")).toMatchObject({ state: "current" });
  });

  it("drops a schedule the Mac's new zone can't hold, and names it for its project only", async () => {
    const store = fakeStore({
      a: [schedule("a1", "a")],
      b: [schedule("b1", "b", { cron: "30 * * * *", timeZone: "Asia/Tokyo" })],
    });
    const job = fakeAdapter();
    let context: ScheduleOsJobContext = { kind: "launch-agent", systemTimeZone: "Asia/Tokyo" };
    const svc = service(store, job.adapter, () => context);
    await svc.start();
    expect(job.syncs.at(-1)?.crons).toEqual(["30 * * * *"]);

    expect(job.zones.at(-1)).toBe("Asia/Tokyo");
    context = MAC;
    const status = await svc.status("a");
    expect(status).toMatchObject({ state: "current", excluded: [] });
    expect(job.syncs.at(-1)?.crons).toEqual(["0 9 * * *"]);
    expect(job.zones.at(-1)).toBe(ZONE);
    expect((await svc.status("b")).excluded).toEqual([
      { scheduleId: "b1", reason: expect.stringMatching(/Asia\/Tokyo/) },
    ]);
  });

  it("puts right a job that drifted before reporting it", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    await svc.start();

    job.drift();
    expect(await svc.status("a")).toMatchObject({ state: "current" });
    expect(job.syncs).toHaveLength(2);
  });

  it("reloads a job launchd dropped though its file still reads current", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    await svc.start();

    job.unload();
    expect(await svc.status("a")).toMatchObject({ state: "current" });
    expect(job.syncs).toHaveLength(2);
  });

  it("reports a failed rewrite and keeps reporting the job stale", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = fakeAdapter();
    job.fail(new Error("Couldn't load the macOS job (launchctl exited 5)"));
    const svc = service(store, job.adapter);
    await svc.start();

    expect(await svc.status("a")).toMatchObject({
      state: "stale",
      error: "Couldn't load the macOS job (launchctl exited 5)",
    });

    job.fail(null);
    expect(await svc.repair("a")).toMatchObject({ state: "current", error: null });
    expect(job.syncs.at(-1)).toEqual({ crons: ["0 9 * * *"], reload: true });
    warn.mockRestore();
  });

  it("reads none when no schedule needs a job and none is installed", async () => {
    const store = fakeStore({ a: [schedule("a1", "a", { runWhenClosed: false })] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    expect(await svc.status("a")).toMatchObject({ state: "none", error: null, excluded: [] });
  });

  it("touches nothing from a copy that can't install the job", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter({ unavailable: "temporary copy" });
    const svc = service(store, job.adapter);
    await svc.start();

    expect(await svc.repair("a")).toMatchObject({ unavailable: "temporary copy", state: "none" });
    expect(job.adapter.sync).not.toHaveBeenCalled();
    expect(job.adapter.observe).not.toHaveBeenCalled();
  });

  it("lets a pass under way finish at dispose, then stops following changes", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    await svc.start();

    const release = job.hold();
    store.commit("a", []);
    await vi.waitFor(() => expect(job.syncs).toHaveLength(2));
    const disposing = svc.dispose().then(() => job.events.push("disposed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(job.events).not.toContain("disposed");
    release();
    await disposing;

    expect(job.events.slice(-2)).toEqual(["synced", "disposed"]);
    expect(store.listenerCount()).toBe(0);
    store.commit("a", [schedule("a1", "a")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(job.syncs).toHaveLength(2);
  });

  it("starts no rewrite from a status read still answering when it's disposed", async () => {
    const store = fakeStore({ a: [schedule("a1", "a")] });
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    await svc.start();
    job.drift();
    const observed = deferred<ScheduleOsJobObservation>();
    vi.mocked(job.adapter.observe).mockReturnValueOnce(observed.promise);

    const reading = svc.status("a");
    await vi.waitFor(() => expect(job.adapter.observe).toHaveBeenCalled());
    await svc.dispose();
    observed.resolve({ installed: true, current: false, loaded: true });

    expect(await reading).toMatchObject({ state: "stale" });
    expect(job.syncs).toHaveLength(1);
  });

  it("writes an edit committed while the first reads are out, even when quitting meanwhile", async () => {
    const store = fakeStore({ a: [], b: [] });
    const slow = deferred<SchedulesSnapshot>();
    store.list.mockImplementation(async (projectId: string) =>
      projectId === "b" ? slow.promise : { projectId, schedules: [], revision: 0 }
    );
    const job = fakeAdapter();
    const svc = service(store, job.adapter);
    const started = svc.start();
    await Promise.resolve();

    store.commit("a", [schedule("a1", "a")]);
    const disposing = svc.dispose().then(() => job.events.push("disposed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(job.events).toEqual([]);
    slow.resolve({ projectId: "b", schedules: [], revision: 0 });
    await disposing;

    expect(job.syncs).toEqual([{ crons: ["0 9 * * *"], reload: false }]);
    expect(job.events).toEqual(["synced", "disposed"]);
    await started;
  });
});
