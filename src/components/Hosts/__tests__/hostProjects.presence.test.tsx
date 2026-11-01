// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMetricsEvent } from "@shared/types/ipc/hostMetrics";
import type { HostProjectPresence, HostSwitchLocatePayload } from "@shared/types/ipc/hostSwitch";
import { useProjectPresence } from "../hostProjects";

interface Pending {
  payload: HostSwitchLocatePayload;
  resolve(answers: HostProjectPresence[]): void;
  reject(error: unknown): void;
}

let pending: Pending[];
const listeners = new Set<(event: HostMetricsEvent) => void>();
const locate = vi.fn(
  (payload: HostSwitchLocatePayload) =>
    new Promise<HostProjectPresence[]>((resolve, reject) => {
      pending.push({ payload, resolve, reject });
    })
);

const has = (hostId: string, projectId = `${hostId}-p`): HostProjectPresence => ({
  hostId,
  projects: [{ projectId, name: "helios", path: `/srv/${projectId}` }],
});
const none = (hostId: string): HostProjectPresence => ({ hostId, projects: [] });

function emit(event: HostMetricsEvent): void {
  for (const listener of [...listeners]) listener(event);
}

/** Answer the request that asked exactly these hosts. */
async function answer(toHostIds: string[], answers: HostProjectPresence[]): Promise<void> {
  const index = pending.findIndex(
    (request) => request.payload.toHostIds.join(",") === toHostIds.join(",")
  );
  if (index < 0) throw new Error(`no request out for ${toHostIds.join(",")}`);
  const [request] = pending.splice(index, 1);
  await act(async () => request!.resolve(answers));
}

function asked(): string[][] {
  return locate.mock.calls.map(([payload]) => payload.toHostIds);
}

beforeEach(() => {
  pending = [];
  locate.mockClear();
  listeners.clear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      hostSwitch: { locate },
      hostMetrics: {
        onEvent: (listener: (event: HostMetricsEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useProjectPresence", () => {
  it("keeps each host's answer when another host is asked again", async () => {
    const { result } = renderHook(() => useProjectPresence("p", ["a", "b"]));
    expect(asked()).toEqual([["a", "b"]]);
    await answer(["a", "b"], [has("a"), none("b")]);

    act(() => emit({ type: "projects", hostId: "b" }));
    expect(asked()).toEqual([["a", "b"], ["b"]]);
    await answer(["b"], [has("b")]);

    expect(result.current.get("a")).toEqual(has("a"));
    expect(result.current.get("b")).toEqual(has("b"));
  });

  it("asks a host once more after its answer when told again while one is out, never twice at once", async () => {
    const { result } = renderHook(() => useProjectPresence("p", ["a"]));
    act(() => {
      emit({ type: "projects", hostId: "a" });
      emit({ type: "projects", hostId: "a" });
    });
    expect(asked()).toEqual([["a"]]);

    await answer(["a"], [none("a")]);
    expect(asked()).toEqual([["a"], ["a"]]);
    await answer(["a"], [has("a")]);
    expect(asked()).toHaveLength(2);
    expect(result.current.get("a")).toEqual(has("a"));
  });

  it("ignores a host that isn't a target, and the projects events of no host", () => {
    renderHook(() => useProjectPresence("p", ["a"]));
    act(() => {
      emit({ type: "projects", hostId: "z" });
      emit({ type: "worktrees", hostId: "a" });
    });
    expect(asked()).toEqual([["a"]]);
  });

  it("lands only a host's newest answer when it left and came back while one was out", async () => {
    const { result, rerender } = renderHook(({ ids }) => useProjectPresence("p", ids), {
      initialProps: { ids: ["a", "b"] },
    });
    rerender({ ids: ["b"] });
    rerender({ ids: ["a", "b"] });
    expect(asked()).toEqual([["a", "b"], ["a"]]);

    await answer(["a"], [has("a")]);
    await answer(["a", "b"], [none("a"), none("b")]);
    expect(result.current.get("a")).toEqual(has("a"));
    expect(result.current.get("b")).toEqual(none("b"));
  });

  it("marks only the hosts a failed lookup asked as unanswerable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useProjectPresence("p", ["a", "b"]));
    await answer(["a", "b"], [has("a"), has("b")]);

    act(() => emit({ type: "projects", hostId: "b" }));
    const request = pending.splice(0, 1)[0]!;
    await act(async () => request.reject(new Error("link dropped")));

    expect(result.current.get("a")).toEqual(has("a"));
    expect(result.current.get("b")).toEqual({ hostId: "b", projects: null });
  });

  it("asks every host for a new project and never shows the last one's answers for it", async () => {
    const { result, rerender } = renderHook(({ projectId }) => useProjectPresence(projectId, ["a"]), {
      initialProps: { projectId: "p" },
    });
    rerender({ projectId: "q" });
    expect(locate.mock.calls.map(([payload]) => payload.projectId)).toEqual(["p", "q"]);

    const [forP, forQ] = pending.splice(0, 2);
    await act(async () => forP!.resolve([has("a")]));
    expect(result.current.size).toBe(0);
    await act(async () => forQ!.resolve([none("a")]));
    expect(result.current.get("a")).toEqual(none("a"));
  });

  it("stops listening and drops a late answer once unmounted", async () => {
    const { result, unmount } = renderHook(() => useProjectPresence("p", ["a"]));
    unmount();
    expect(listeners.size).toBe(0);
    await answer(["a"], [has("a")]);
    expect(result.current.size).toBe(0);
  });
});
