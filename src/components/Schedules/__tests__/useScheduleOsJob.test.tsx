// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ScheduleOsJobStatus } from "@shared/types/ipc/schedules";

const clientMock = vi.hoisted(() => ({
  osJobStatus: vi.fn(),
  repairOsJob: vi.fn(),
}));
vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: clientMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { useScheduleOsJob } from "../useScheduleOsJob";

function status(state: ScheduleOsJobStatus["state"], error: string | null = null) {
  return {
    context: { kind: "launch-agent", systemTimeZone: "UTC" },
    unavailable: null,
    state,
    error,
    excluded: [],
  } satisfies ScheduleOsJobStatus;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(initial: { enabled: boolean; revision: number | null }) {
  return renderHook((props) => useScheduleOsJob(props.enabled, props.revision), {
    initialProps: initial,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useScheduleOsJob (#15990)", () => {
  it("reads nothing until the dialog is open on a project's schedules", () => {
    mount({ enabled: false, revision: 1 });
    mount({ enabled: true, revision: null });
    expect(clientMock.osJobStatus).not.toHaveBeenCalled();
  });

  it("keeps the newest read when an older one answers last", async () => {
    const first = deferred<ScheduleOsJobStatus>();
    const second = deferred<ScheduleOsJobStatus>();
    clientMock.osJobStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = mount({ enabled: true, revision: 1 });
    hook.rerender({ enabled: true, revision: 2 });

    await act(async () => second.resolve(status("current")));
    await act(async () => first.resolve(status("stale")));

    expect(hook.result.current.status?.state).toBe("current");
  });

  it("drops an answer that comes after the dialog closed", async () => {
    const pending = deferred<ScheduleOsJobStatus>();
    clientMock.osJobStatus.mockReturnValueOnce(pending.promise);
    const hook = mount({ enabled: true, revision: 1 });
    hook.rerender({ enabled: false, revision: 1 });

    await act(async () => pending.resolve(status("stale")));

    expect(hook.result.current.status).toBeNull();
  });

  it("ends a repair a newer read overtook, keeping the read's answer", async () => {
    clientMock.osJobStatus
      .mockResolvedValueOnce(status("stale"))
      .mockResolvedValueOnce(status("current"));
    const repair = deferred<ScheduleOsJobStatus>();
    clientMock.repairOsJob.mockReturnValueOnce(repair.promise);
    const hook = mount({ enabled: true, revision: 1 });
    await act(async () => {});

    act(() => hook.result.current.repair());
    expect(hook.result.current.repairing).toBe(true);
    hook.rerender({ enabled: true, revision: 2 });
    await act(async () => {});
    await act(async () => repair.resolve(status("stale", "late repair")));

    expect(hook.result.current).toMatchObject({
      repairing: false,
      status: { state: "current" },
      error: null,
    });
  });

  it("says a repair failed and keeps the status it had", async () => {
    clientMock.osJobStatus.mockResolvedValueOnce(status("stale"));
    clientMock.repairOsJob.mockRejectedValueOnce(new Error("launchctl hung"));
    const hook = mount({ enabled: true, revision: 1 });
    await act(async () => {});

    await act(async () => hook.result.current.repair());

    expect(hook.result.current).toMatchObject({
      repairing: false,
      status: { state: "stale" },
      error: "launchctl hung",
    });
  });
});
