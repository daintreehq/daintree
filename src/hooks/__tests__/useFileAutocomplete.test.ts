// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/clients/filesClient", () => ({
  filesClient: { search: vi.fn() },
}));

import { filesClient } from "@/clients/filesClient";
import { useFileAutocomplete } from "../useFileAutocomplete";

const searchMock = vi.mocked(filesClient.search);

interface Deferred {
  resolve: (files: string[]) => void;
  reject: (err: unknown) => void;
}

function enqueueDeferred(): Deferred {
  const deferred = {} as Deferred;
  searchMock.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        deferred.resolve = (files: string[]) => resolve({ files });
        deferred.reject = reject;
      })
  );
  return deferred;
}

describe("useFileAutocomplete", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks the query that produced the current results", async () => {
    const first = enqueueDeferred();
    const { result, rerender } = renderHook(
      ({ query }) => useFileAutocomplete({ cwd: "/repo", query, enabled: true }),
      { initialProps: { query: "" } }
    );

    expect(result.current.resultsQuery).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      first.resolve(["a.ts", "b.ts"]);
    });
    expect(result.current.files).toEqual(["a.ts", "b.ts"]);
    expect(result.current.resultsQuery).toBe("");
    expect(result.current.isLoading).toBe(false);

    // Query changes: during debounce + in-flight search the old results stay
    // visible but resultsQuery still names the old query (the stale window).
    const second = enqueueDeferred();
    rerender({ query: "src" });
    expect(result.current.resultsQuery).toBe("");
    expect(result.current.files).toEqual(["a.ts", "b.ts"]);

    await act(async () => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current.resultsQuery).toBe("");

    await act(async () => {
      second.resolve(["src/index.ts"]);
    });
    expect(result.current.files).toEqual(["src/index.ts"]);
    expect(result.current.resultsQuery).toBe("src");
  });

  it("ignores out-of-order resolutions from superseded requests", async () => {
    const first = enqueueDeferred();
    const { result, rerender } = renderHook(
      ({ query }) => useFileAutocomplete({ cwd: "/repo", query, enabled: true }),
      { initialProps: { query: "a" } }
    );

    const second = enqueueDeferred();
    rerender({ query: "ab" });
    await act(async () => {
      vi.advanceTimersByTime(80);
    });

    // Newer request resolves first; the older one lands afterwards and must
    // not clobber files or resultsQuery.
    await act(async () => {
      second.resolve(["ab.ts"]);
    });
    expect(result.current.files).toEqual(["ab.ts"]);
    expect(result.current.resultsQuery).toBe("ab");

    await act(async () => {
      first.resolve(["a.ts"]);
    });
    expect(result.current.files).toEqual(["ab.ts"]);
    expect(result.current.resultsQuery).toBe("ab");
    expect(result.current.isLoading).toBe(false);
  });

  it("debounces query changes before searching", async () => {
    enqueueDeferred();
    const { rerender } = renderHook(
      ({ query }) => useFileAutocomplete({ cwd: "/repo", query, enabled: true }),
      { initialProps: { query: "" } }
    );
    expect(searchMock).toHaveBeenCalledTimes(1);

    enqueueDeferred();
    rerender({ query: "src" });
    await act(async () => {
      vi.advanceTimersByTime(74);
    });
    expect(searchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock).toHaveBeenLastCalledWith({ cwd: "/repo", query: "src", limit: 50 });
  });

  it("ignores an in-flight search that resolves after being disabled", async () => {
    const first = enqueueDeferred();
    const { result, rerender } = renderHook(
      ({ enabled }) => useFileAutocomplete({ cwd: "/repo", query: "", enabled }),
      { initialProps: { enabled: true } }
    );

    rerender({ enabled: false });

    await act(async () => {
      first.resolve(["a.ts"]);
    });
    expect(result.current.files).toEqual([]);
    expect(result.current.resultsQuery).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("treats results from a previous cwd as stale", async () => {
    const first = enqueueDeferred();
    const { result, rerender } = renderHook(
      ({ cwd }) => useFileAutocomplete({ cwd, query: "", enabled: true }),
      { initialProps: { cwd: "/repo-a" } }
    );

    await act(async () => {
      first.resolve(["a.ts"]);
    });
    expect(result.current.resultsQuery).toBe("");

    const second = enqueueDeferred();
    rerender({ cwd: "/repo-b" });
    // Same query text, different worktree — the old results must not read
    // as current until the new cwd's search resolves.
    expect(result.current.resultsQuery).toBeNull();

    await act(async () => {
      second.resolve(["b.ts"]);
    });
    expect(result.current.files).toEqual(["b.ts"]);
    expect(result.current.resultsQuery).toBe("");
  });

  it("clears files and resultsQuery when disabled", async () => {
    const first = enqueueDeferred();
    const { result, rerender } = renderHook(
      ({ enabled }) => useFileAutocomplete({ cwd: "/repo", query: "", enabled }),
      { initialProps: { enabled: true } }
    );

    await act(async () => {
      first.resolve(["a.ts"]);
    });
    expect(result.current.files).toEqual(["a.ts"]);
    expect(result.current.resultsQuery).toBe("");

    rerender({ enabled: false });
    expect(result.current.files).toEqual([]);
    expect(result.current.resultsQuery).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("records resultsQuery when a search fails so the empty state is not stale", async () => {
    const first = enqueueDeferred();
    const { result } = renderHook(() =>
      useFileAutocomplete({ cwd: "/repo", query: "zzz", enabled: true })
    );

    await act(async () => {
      first.reject(new Error("search failed"));
    });
    expect(result.current.files).toEqual([]);
    expect(result.current.resultsQuery).toBe("zzz");
    expect(result.current.isLoading).toBe(false);
  });
});
