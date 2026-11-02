import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ScheduleStore } from "../../../ScheduleStore.js";
import { ScheduleOsJobService, type ScheduleOsJobAdapter } from "../../ScheduleOsJobService.js";
import type { ScheduleSwitchesPatch } from "../../../../../shared/types/ipc/schedules.js";
import type { ScheduleOsJobContext } from "../../../../../shared/utils/scheduleOsJob.js";

/** One platform's real adapter, over a fake of what the OS holds. */
export interface ProjectSwitchHarness {
  adapter: ScheduleOsJobAdapter;
  context: ScheduleOsJobContext;
  /** Whether the OS holds the job and would start Daintree from it. */
  live(): boolean;
  /** The hours of the day the job the OS holds starts Daintree at, sorted; none without one. */
  hours(): number[];
}

const A = "a".repeat(64);
const B = "b".repeat(64);

/**
 * Drives the machine's job through each transition of two projects' switches
 * (#16166), from the store's commits to what the OS ends up holding.
 */
export function itFollowsProjectSwitches(makeHarness: () => ProjectSwitchHarness): void {
  it("installs, rewrites and removes the job as each project's switches change (#16166)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-switch-transitions-"));
    const registered = new Set([A, B]);
    const store = new ScheduleStore(
      root,
      (id) => registered.has(id),
      () => Date.UTC(2026, 10, 1, 12)
    );
    const harness = makeHarness();
    const service = new ScheduleOsJobService({
      adapter: harness.adapter,
      listProjectIds: () => [...registered],
      listSchedules: (projectId) => store.list(projectId),
      subscribeSchedules: (listener) => store.subscribe(listener),
      context: () => harness.context,
      readTimeoutMs: 1_000,
      drainTimeoutMs: 1_000,
    });
    const job = async () => {
      const status = await service.status(A);
      return { state: status.state, live: harness.live(), hours: harness.hours() };
    };
    const set = async (projectId: string, patch: ScheduleSwitchesPatch) => {
      expect((await store.setSwitches(projectId, patch)).status).toBe("saved");
      return job();
    };
    const asking = (cron: string) => ({
      name: cron,
      launch: { agentId: "claude", prompt: "Go." },
      cron,
      timeZone: harness.context.systemTimeZone!,
      policies: { runWhenClosed: true },
    });
    const none = { state: "none", live: false, hours: [] };
    const covering = (...hours: number[]) => ({ state: "current", live: true, hours });

    try {
      expect((await store.create(A, asking("0 9 * * *"))).status).toBe("saved");
      expect((await store.create(B, asking("0 18 * * *"))).status).toBe("saved");
      await service.start();
      // A schedule asking for the job does nothing while its project's switches are off.
      expect(await job()).toEqual(none);

      expect(await set(A, { schedulesOn: true })).toEqual(none);
      expect(await set(A, { startWhenClosed: true })).toEqual(covering(9));
      expect(await set(B, { schedulesOn: true, startWhenClosed: true })).toEqual(covering(9, 18));
      expect(await set(A, { startWhenClosed: false })).toEqual(covering(18));
      expect(await set(A, { startWhenClosed: true })).toEqual(covering(9, 18));
      expect(await set(A, { schedulesOn: false })).toEqual(covering(18));
      // The last project needing it turns its schedules off: the job goes.
      expect(await set(B, { schedulesOn: false })).toEqual(none);
      expect(await set(B, { schedulesOn: true })).toEqual(covering(18));

      // Removing the project from Daintree leaves none of its schedules in the job.
      registered.delete(B);
      await store.removeProject(B);
      expect(await job()).toEqual(none);
    } finally {
      await service.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
