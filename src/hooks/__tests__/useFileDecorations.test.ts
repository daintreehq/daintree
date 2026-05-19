// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { FileDecoration } from "@shared/types/forge";

const { getDecorationsMock, onDecorationsChangedMock } = vi.hoisted(() => ({
  getDecorationsMock: vi.fn(),
  onDecorationsChangedMock: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        getDecorations: getDecorationsMock,
        onDecorationsChanged: onDecorationsChangedMock,
      },
    },
  });
  getDecorationsMock.mockResolvedValue({});
  onDecorationsChangedMock.mockReturnValue(() => {});
});

async function load() {
  const { useFileDecorations } = await import("../useFileDecorations");
  return useFileDecorations;
}

describe("useFileDecorations", () => {
  it("pulls decorations on mount for the given scope and paths", async () => {
    const decos: Record<string, FileDecoration> = { "a.ts": { badge: "2" } };
    getDecorationsMock.mockResolvedValue(decos);
    const useFileDecorations = await load();

    const { result } = renderHook(() => useFileDecorations("worktree-diff:/r", ["a.ts", "b.ts"]));

    await waitFor(() => {
      expect(result.current).toEqual(decos);
    });
    expect(getDecorationsMock).toHaveBeenCalledWith("worktree-diff:/r", ["a.ts", "b.ts"]);
  });

  it("returns a stable empty object and skips IPC when scope is empty", async () => {
    const useFileDecorations = await load();
    const { result, rerender } = renderHook(
      ({ s }: { s: string }) => useFileDecorations(s, ["a.ts"]),
      { initialProps: { s: "" } }
    );
    const first = result.current;
    rerender({ s: "" });
    expect(result.current).toBe(first);
    expect(getDecorationsMock).not.toHaveBeenCalled();
  });

  it("skips IPC when there are no paths", async () => {
    const useFileDecorations = await load();
    renderHook(() => useFileDecorations("s:1", []));
    expect(getDecorationsMock).not.toHaveBeenCalled();
  });

  it("deduplicates and sorts paths before fetching", async () => {
    const useFileDecorations = await load();
    renderHook(() => useFileDecorations("s:1", ["b.ts", "a.ts", "b.ts"]));
    await waitFor(() => {
      expect(getDecorationsMock).toHaveBeenCalledWith("s:1", ["a.ts", "b.ts"]);
    });
  });

  it("re-pulls when a matching invalidation event fires", async () => {
    let listener: ((p: { scope: string; paths?: string[] }) => void) | undefined;
    onDecorationsChangedMock.mockImplementation((cb: typeof listener) => {
      listener = cb;
      return () => {};
    });
    getDecorationsMock.mockResolvedValueOnce({ "a.ts": { badge: "1" } });
    const useFileDecorations = await load();

    const { result } = renderHook(() => useFileDecorations("s:1", ["a.ts"]));
    await waitFor(() => expect(result.current).toEqual({ "a.ts": { badge: "1" } }));

    getDecorationsMock.mockResolvedValueOnce({ "a.ts": { badge: "5" } });
    act(() => listener?.({ scope: "s:1" }));
    await waitFor(() => expect(result.current).toEqual({ "a.ts": { badge: "5" } }));
  });

  it("ignores invalidation for a different scope", async () => {
    let listener: ((p: { scope: string; paths?: string[] }) => void) | undefined;
    onDecorationsChangedMock.mockImplementation((cb: typeof listener) => {
      listener = cb;
      return () => {};
    });
    const useFileDecorations = await load();
    renderHook(() => useFileDecorations("s:1", ["a.ts"]));
    await waitFor(() => expect(getDecorationsMock).toHaveBeenCalledTimes(1));

    act(() => listener?.({ scope: "other:scope" }));
    // No additional fetch for the unrelated scope.
    expect(getDecorationsMock).toHaveBeenCalledTimes(1);
  });

  it("re-pulls on a wildcard payload scope (plugin-unload broadcast)", async () => {
    let listener: ((p: { scope: string; paths?: string[] }) => void) | undefined;
    onDecorationsChangedMock.mockImplementation((cb: typeof listener) => {
      listener = cb;
      return () => {};
    });
    getDecorationsMock.mockResolvedValueOnce({ "a.ts": { badge: "1" } });
    const useFileDecorations = await load();
    const { result } = renderHook(() => useFileDecorations("worktree-diff:/r", ["a.ts"]));
    await waitFor(() => expect(result.current).toEqual({ "a.ts": { badge: "1" } }));

    getDecorationsMock.mockResolvedValueOnce({});
    act(() => listener?.({ scope: "worktree-diff:*" }));
    await waitFor(() => expect(result.current).toEqual({}));
  });

  it("ignores a stale fetch that resolves after a newer one", async () => {
    let listener: ((p: { scope: string; paths?: string[] }) => void) | undefined;
    onDecorationsChangedMock.mockImplementation((cb: typeof listener) => {
      listener = cb;
      return () => {};
    });
    let resolveFirst: ((v: Record<string, FileDecoration>) => void) | undefined;
    getDecorationsMock.mockReturnValueOnce(
      new Promise<Record<string, FileDecoration>>((res) => {
        resolveFirst = res;
      })
    );
    const useFileDecorations = await load();
    const { result } = renderHook(() => useFileDecorations("s:1", ["a.ts"]));

    // Second fetch (from invalidation) resolves first with the fresh value.
    getDecorationsMock.mockResolvedValueOnce({ "a.ts": { badge: "new" } });
    act(() => listener?.({ scope: "s:1" }));
    await waitFor(() => expect(result.current).toEqual({ "a.ts": { badge: "new" } }));

    // The stale first fetch resolves late — it must NOT clobber the fresh value.
    act(() => resolveFirst?.({ "a.ts": { badge: "stale" } }));
    await Promise.resolve();
    expect(result.current).toEqual({ "a.ts": { badge: "new" } });
  });

  it("ignores invalidation whose narrowed paths don't intersect visible paths", async () => {
    let listener: ((p: { scope: string; paths?: string[] }) => void) | undefined;
    onDecorationsChangedMock.mockImplementation((cb: typeof listener) => {
      listener = cb;
      return () => {};
    });
    const useFileDecorations = await load();
    renderHook(() => useFileDecorations("s:1", ["a.ts"]));
    await waitFor(() => expect(getDecorationsMock).toHaveBeenCalledTimes(1));

    act(() => listener?.({ scope: "s:1", paths: ["unrelated.ts"] }));
    expect(getDecorationsMock).toHaveBeenCalledTimes(1);
  });
});
