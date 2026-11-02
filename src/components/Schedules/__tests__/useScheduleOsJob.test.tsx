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
    context: { kind: "launch-agent", systemTimeZone: "UTC", unavailable: null },
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

  it("checks from a change until the read made after it answers, with what it was asked about (#16168)", async () => {
    const first = deferred<ScheduleOsJobStatus>();
    const second = deferred<ScheduleOsJobStatus>();
    clientMock.osJobStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const hook = renderHook(
      (props: { revision: number; basis: string }) =>
        useScheduleOsJob(true, props.revision, props.basis),
      { initialProps: { revision: 1, basis: "off" } }
    );
    expect(hook.result.current.checking).toBe(true);
    await act(async () => first.resolve(status("none")));
    expect(hook.result.current).toMatchObject({ checking: false, basis: "off" });

    hook.rerender({ revision: 2, basis: "on" });
    // The last answer stays up, still about what it was read against.
    expect(hook.result.current).toMatchObject({
      checking: true,
      basis: "off",
      status: { state: "none" },
    });
    await act(async () => second.resolve(status("current")));
    expect(hook.result.current).toMatchObject({
      checking: false,
      basis: "on",
      status: { state: "current" },
    });
  });

  it("stops checking when the read fails, saying why", async () => {
    clientMock.osJobStatus.mockRejectedValueOnce(new Error("main went away"));
    const hook = mount({ enabled: true, revision: 1 });
    await act(async () => {});
    expect(hook.result.current).toMatchObject({ checking: false, error: "main went away" });
  });

  it("takes a repair's answer as the read for the change it was asked about", async () => {
    clientMock.osJobStatus.mockResolvedValueOnce(status("stale"));
    clientMock.repairOsJob.mockResolvedValueOnce(status("current"));
    const hook = renderHook(
      (props: { revision: number; basis: string }) =>
        useScheduleOsJob(true, props.revision, props.basis),
      { initialProps: { revision: 1, basis: "first" } }
    );
    await act(async () => {});

    await act(async () => hook.result.current.repair());
    expect(hook.result.current).toMatchObject({
      checking: false,
      basis: "first",
      status: { state: "current" },
    });
  });

  it("stops checking when a repair that overtook a read fails", async () => {
    clientMock.osJobStatus
      .mockResolvedValueOnce(status("stale"))
      .mockReturnValueOnce(new Promise(() => {}));
    clientMock.repairOsJob.mockRejectedValueOnce(new Error("launchctl hung"));
    const hook = mount({ enabled: true, revision: 1 });
    await act(async () => {});
    hook.rerender({ enabled: true, revision: 2 });
    expect(hook.result.current.checking).toBe(true);

    await act(async () => hook.result.current.repair());
    expect(hook.result.current).toMatchObject({
      checking: false,
      error: "launchctl hung",
      status: { state: "stale" },
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
