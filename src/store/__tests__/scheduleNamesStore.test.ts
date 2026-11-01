// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";

const { client, remote } = vi.hoisted(() => ({
  client: {
    list: vi.fn(),
    onChanged: vi.fn(),
  },
  remote: { value: false },
}));

vi.mock("@/clients/schedulesClient", () => ({ schedulesClient: client }));
vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => remote.value }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import {
  _resetScheduleNamesForTests,
  acquireScheduleNames,
  readScheduleName,
  retryScheduleNames,
  scheduleNameLabel,
  useScheduleNames,
  useScheduleNamesStore,
} from "../scheduleNamesStore";

function snapshot(
  revision: number,
  schedules: Record<string, string>,
  projectId = "proj-a"
): SchedulesSnapshot {
  return {
    projectId,
    revision,
    schedules: Object.entries(schedules).map(([id, name]) => ({ id, name })),
  } as unknown as SchedulesSnapshot;
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

let push: ((snapshot: SchedulesSnapshot) => void) | undefined;
const offChanged = vi.fn();

function nameOf(scheduleId: string) {
  const { status, names } = useScheduleNamesStore.getState();
  return readScheduleName(scheduleId, status, names);
}

beforeEach(() => {
  _resetScheduleNamesForTests();
  remote.value = false;
  push = undefined;
  offChanged.mockReset();
  client.list.mockReset();
  client.onChanged.mockReset();
  client.onChanged.mockImplementation((callback: (snapshot: SchedulesSnapshot) => void) => {
    push = callback;
    return offChanged;
  });
});

describe("scheduleNamesStore", () => {
  it("reads nothing until something holds the names", () => {
    expect(client.list).not.toHaveBeenCalled();
    expect(client.onChanged).not.toHaveBeenCalled();
    expect(useScheduleNamesStore.getState().status).toBe("idle");
  });

  it("subscribes before it reads, and every holder shares one read", async () => {
    const reply = deferred<SchedulesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    const order: string[] = [];
    client.onChanged.mockImplementation((callback: (s: SchedulesSnapshot) => void) => {
      order.push("subscribe");
      push = callback;
      return offChanged;
    });
    client.list.mockImplementation(() => {
      order.push("list");
      return reply.promise;
    });

    const releaseA = acquireScheduleNames();
    const releaseB = acquireScheduleNames();
    expect(order).toEqual(["subscribe", "list"]);
    expect(nameOf("s1")).toEqual({ kind: "unnamed" });

    await act(async () => reply.resolve(snapshot(1, { s1: "Nightly triage" })));
    expect(nameOf("s1")).toEqual({ kind: "named", name: "Nightly triage" });
    expect(nameOf("gone")).toEqual({ kind: "deleted" });

    releaseA();
    expect(offChanged).not.toHaveBeenCalled();
    releaseB();
    expect(offChanged).toHaveBeenCalledTimes(1);
    expect(useScheduleNamesStore.getState().status).toBe("idle");
  });

  it("takes a newer push and ignores an older reply that crosses it", async () => {
    const reply = deferred<SchedulesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    acquireScheduleNames();

    act(() => push?.(snapshot(3, { s1: "Renamed" })));
    await act(async () => reply.resolve(snapshot(2, { s1: "Original" })));
    expect(nameOf("s1")).toEqual({ kind: "named", name: "Renamed" });

    act(() => push?.(snapshot(4, {})));
    expect(nameOf("s1")).toEqual({ kind: "deleted" });
  });

  it("never reads a failed read as a deleted schedule, and reads again for the next holder", async () => {
    client.list.mockRejectedValueOnce(new Error("boom"));
    acquireScheduleNames();
    await act(async () => {});
    expect(useScheduleNamesStore.getState().status).toBe("failed");
    expect(nameOf("s1")).toEqual({ kind: "unnamed" });

    client.list.mockResolvedValueOnce(snapshot(1, { s1: "Nightly" }));
    acquireScheduleNames();
    await act(async () => {});
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(nameOf("s1")).toEqual({ kind: "named", name: "Nightly" });
  });

  it("reads a view not yet showing a project as a failed read", async () => {
    client.list.mockResolvedValueOnce(null);
    acquireScheduleNames();
    await act(async () => {});
    expect(useScheduleNamesStore.getState().status).toBe("failed");

    // A push answers it.
    act(() => push?.(snapshot(1, { s1: "Nightly" })));
    expect(nameOf("s1")).toEqual({ kind: "named", name: "Nightly" });
  });

  it("retries a failed read only while held, and only once at a time", async () => {
    client.list.mockRejectedValueOnce(new Error("boom"));
    const release = acquireScheduleNames();
    await act(async () => {});

    const reply = deferred<SchedulesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    retryScheduleNames();
    retryScheduleNames();
    expect(client.list).toHaveBeenCalledTimes(2);

    await act(async () => reply.resolve(snapshot(1, { s1: "Nightly" })));
    release();
    retryScheduleNames();
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("drops a reply or push that arrives after the last holder let go", async () => {
    const reply = deferred<SchedulesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    const release = acquireScheduleNames();
    const stalePush = push;
    release();

    await act(async () => reply.resolve(snapshot(1, { s1: "Nightly" })));
    act(() => stalePush?.(snapshot(2, { s1: "Nightly" })));
    expect(useScheduleNamesStore.getState().status).toBe("idle");
  });

  it("asks nothing in a window driving a Remote Host", () => {
    remote.value = true;
    acquireScheduleNames();
    expect(client.list).not.toHaveBeenCalled();
    expect(client.onChanged).not.toHaveBeenCalled();
    expect(nameOf("s1")).toEqual({ kind: "remote" });
  });

  it("puts each reading into the words beside the mark", () => {
    expect(scheduleNameLabel({ kind: "named", name: "Nightly" })).toBe("Nightly");
    expect(scheduleNameLabel({ kind: "deleted" })).not.toBe(
      scheduleNameLabel({ kind: "unnamed" })
    );
    expect(scheduleNameLabel({ kind: "remote" })).toBe(scheduleNameLabel({ kind: "unnamed" }));
  });
});

describe("useScheduleNames", () => {
  it("holds the names only while enabled", async () => {
    client.list.mockResolvedValue(snapshot(1, { s1: "Nightly" }));
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useScheduleNames(enabled),
      { initialProps: { enabled: false } }
    );
    expect(client.list).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");

    rerender({ enabled: true });
    await act(async () => {});
    expect(result.current.names.get("s1")).toBe("Nightly");

    unmount();
    expect(offChanged).toHaveBeenCalledTimes(1);
  });

  it("doesn't re-render a disabled consumer when another holder's names change", async () => {
    client.list.mockResolvedValue(snapshot(1, { s1: "Nightly" }));
    let renders = 0;
    renderHook(() => {
      renders++;
      return useScheduleNames(false);
    });
    const before = renders;

    acquireScheduleNames();
    await act(async () => {});
    act(() => push?.(snapshot(2, { s1: "Renamed" })));
    expect(renders).toBe(before);
  });
});
