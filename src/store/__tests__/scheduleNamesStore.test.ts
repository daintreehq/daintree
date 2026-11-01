// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

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

/** What main pushes and answers, as far as the schedule names read it. */
type NamesSnapshot = {
  projectId: string;
  revision: number;
  schedules: { id: string; name: string }[];
};

function snapshot(
  revision: number,
  schedules: Record<string, string>,
  projectId = "proj-a"
): NamesSnapshot {
  return {
    projectId,
    revision,
    schedules: Object.entries(schedules).map(([id, name]) => ({ id, name })),
  };
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

let push: ((snapshot: NamesSnapshot) => void) | undefined;
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
  client.onChanged.mockImplementation((callback: (snapshot: NamesSnapshot) => void) => {
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
    const reply = deferred<NamesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    const order: string[] = [];
    client.onChanged.mockImplementation((callback: (s: NamesSnapshot) => void) => {
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
    await act(async () => {});
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
    const reply = deferred<NamesSnapshot | null>();
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

    const reply = deferred<NamesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    retryScheduleNames();
    retryScheduleNames();
    await act(async () => {});
    expect(client.list).toHaveBeenCalledTimes(2);

    await act(async () => reply.resolve(snapshot(1, { s1: "Nightly" })));
    release();
    retryScheduleNames();
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("drops a reply or push that arrives after the last holder let go", async () => {
    const reply = deferred<NamesSnapshot | null>();
    client.list.mockReturnValue(reply.promise);
    const release = acquireScheduleNames();
    const stalePush = push;
    release();

    await act(async () => reply.resolve(snapshot(1, { s1: "Nightly" })));
    act(() => stalePush?.(snapshot(2, { s1: "Nightly" })));
    expect(useScheduleNamesStore.getState().status).toBe("idle");
  });

  it("fails the read, not the holder, when the bridge throws as it's called", async () => {
    client.list.mockImplementation(() => {
      throw new Error("no bridge");
    });
    expect(() => acquireScheduleNames()).not.toThrow();
    await act(async () => {});
    expect(useScheduleNamesStore.getState().status).toBe("failed");
  });

  it("asks nothing in a window driving a Remote Host", () => {
    remote.value = true;
    acquireScheduleNames();
    expect(client.list).not.toHaveBeenCalled();
    expect(client.onChanged).not.toHaveBeenCalled();
    expect(nameOf("s1")).toEqual({ kind: "remote" });
  });

  it("says deleted only for a schedule the read found missing", () => {
    expect(scheduleNameLabel({ kind: "named", name: "Nightly" })).toBe("Nightly");
    expect(scheduleNameLabel({ kind: "deleted" })).toMatch(/deleted/i);
    expect(scheduleNameLabel({ kind: "unnamed" })).not.toMatch(/deleted/i);
    expect(scheduleNameLabel({ kind: "remote" })).not.toMatch(/deleted/i);
  });

  it("keeps names a push brought when the first read then fails or finds no project", async () => {
    for (const settle of ["reject", "null"] as const) {
      _resetScheduleNamesForTests();
      const reply = deferred<NamesSnapshot | null>();
      client.list.mockReturnValue(reply.promise);
      acquireScheduleNames();
      await act(async () => {});
      act(() => push?.(snapshot(1, { s1: "Nightly" })));

      await act(async () =>
        settle === "reject" ? reply.reject(new Error("boom")) : reply.resolve(null)
      );
      expect(useScheduleNamesStore.getState().status).toBe("ready");
      expect(nameOf("s1")).toEqual({ kind: "named", name: "Nightly" });
    }
  });

  it("leaves the names as they are for a snapshot of a revision already taken", async () => {
    client.list.mockResolvedValue(snapshot(1, { s1: "Nightly" }));
    acquireScheduleNames();
    await act(async () => {});
    const names = useScheduleNamesStore.getState().names;

    act(() => push?.(snapshot(1, { s1: "Nightly" })));
    expect(useScheduleNamesStore.getState().names).toBe(names);
  });

  it("lets a read from before a quick release and re-hold change nothing, settled either way", async () => {
    const stale = deferred<NamesSnapshot | null>();
    const staleFailure = deferred<NamesSnapshot | null>();
    const fresh = deferred<NamesSnapshot | null>();
    client.list
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(staleFailure.promise)
      .mockReturnValueOnce(fresh.promise);

    acquireScheduleNames()();
    await act(async () => {});
    acquireScheduleNames()();
    await act(async () => {});
    acquireScheduleNames();
    await act(async () => {});
    expect(client.list).toHaveBeenCalledTimes(3);

    await act(async () => stale.resolve(snapshot(9, { s1: "Old" })));
    await act(async () => staleFailure.reject(new Error("boom")));
    expect(useScheduleNamesStore.getState().status).toBe("loading");

    await act(async () => fresh.resolve(snapshot(1, { s1: "Nightly" })));
    expect(nameOf("s1")).toEqual({ kind: "named", name: "Nightly" });
  });

  it("keeps a read from before a release from freeing a retry still in flight", async () => {
    const stale = deferred<NamesSnapshot | null>();
    const retry = deferred<NamesSnapshot | null>();
    client.list
      .mockReturnValueOnce(stale.promise)
      .mockRejectedValueOnce(new Error("boom"))
      .mockReturnValueOnce(retry.promise);

    acquireScheduleNames()();
    await act(async () => {});
    acquireScheduleNames();
    await act(async () => {});
    expect(useScheduleNamesStore.getState().status).toBe("failed");

    retryScheduleNames();
    await act(async () => {});
    expect(client.list).toHaveBeenCalledTimes(3);

    // The stale read settling mustn't mark the retry as finished.
    await act(async () => stale.resolve(null));
    retryScheduleNames();
    await act(async () => {});
    expect(client.list).toHaveBeenCalledTimes(3);
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
