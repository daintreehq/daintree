import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
    const held = () => ({ live: harness.live(), hours: harness.hours() });
    const job = async () => {
      const status = await service.status(A);
      return { state: status.state, ...held() };
    };
    /**
     * The OS is waited on before the status is read: a status read repairs a
     * job that drifted, which would hide a commit that never reached it.
     */
    const set = async (
      projectId: string,
      patch: ScheduleSwitchesPatch,
      expected: { state: string; live: boolean; hours: number[] }
    ) => {
      expect((await store.setSwitches(projectId, patch)).status).toBe("saved");
      const { state: _state, ...onOs } = expected;
      await vi.waitFor(() => expect(held()).toEqual(onOs), { timeout: 2_000, interval: 5 });
      expect(await job()).toEqual(expected);
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

      await set(A, { schedulesOn: true }, none);
      await set(A, { startWhenClosed: true }, covering(9));
      await set(B, { schedulesOn: true, startWhenClosed: true }, covering(9, 18));
      await set(A, { startWhenClosed: false }, covering(18));
      await set(A, { startWhenClosed: true }, covering(9, 18));
      await set(A, { schedulesOn: false }, covering(18));
      // The last project needing it turns either switch off: the job goes.
      await set(B, { startWhenClosed: false }, none);
      await set(B, { startWhenClosed: true }, covering(18));
      await set(B, { schedulesOn: false }, none);
      await set(B, { schedulesOn: true }, covering(18));

      // Removing the project from Daintree leaves none of its schedules in the job.
      registered.delete(B);
      await store.removeProject(B);
      await vi.waitFor(() => expect(held()).toEqual({ live: false, hours: [] }), {
        timeout: 2_000,
        interval: 5,
      });
      expect(await job()).toEqual(none);
    } finally {
      await service.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
