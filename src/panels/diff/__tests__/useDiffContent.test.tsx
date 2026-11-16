// @vitest-environment jsdom
import { useMemo } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { DiffSubject } from "../diffContentCache";
import { useDiffContent } from "../useDiffContent";

const { requestDiffMock } = vi.hoisted(() => ({
  requestDiffMock: vi.fn<(subject: DiffSubject) => Promise<{ content: string } | null>>(),
}));

vi.mock("../diffContentCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../diffContentCache")>()),
  requestDiff: requestDiffMock,
  purgeWhitespaceEntriesExcept: vi.fn(),
}));

// No worktree-store provider is mounted, so freshness never fires — this file
// is about which subject the returned content belongs to.
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (state: unknown) => unknown) =>
    selector({ diffIgnoreWhitespace: false }),
}));

const PATCH_A = "diff --git a/a.ts b/a.ts\nindex 83db48f..bf269f4 100644";
const PATCH_B = "diff --git a/vendor/sub b/vendor/sub\nindex ada605e..029ae62 160000";

/**
 * The hook depends on its subject by identity ("callers must memoize them"), so
 * a fresh object each render would rebuild `fetchDiff` and refetch forever.
 */
function useSubject(filePath: string): DiffSubject {
  return useMemo(
    () =>
      ({ source: "working-tree", worktreePath: "/repo", filePath, status: "modified" }) as const,
    [filePath]
  );
}

beforeEach(() => {
  requestDiffMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lands the current diff, then runs out the dwell the next-file prefetch waits for. */
async function settlePrefetch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

describe("useDiffContent", () => {
  it("never reports one file's patch under another file's subject", async () => {
    // Callers read the patch to decide what the new side IS — a gitlink has no
    // readable file (#12309) — so handing back the previous file's patch for
    // even one render lets a whole-file read fire at the wrong path.
    requestDiffMock.mockImplementation(async (s) => ({
      content: s.filePath === "a.ts" ? PATCH_A : PATCH_B,
    }));

    // Recorded during render: the offending pairing existed for exactly one
    // commit, which an assertion made after `act` has flushed would miss.
    const seen: Array<{ file: string; content: string | undefined }> = [];
    const { result, rerender } = renderHook(
      ({ file }) => {
        const value = useDiffContent(useSubject(file));
        seen.push({ file, content: value.content });
        return value;
      },
      { initialProps: { file: "a.ts" } }
    );
    await waitFor(() => expect(result.current.content).toBe(PATCH_A));

    rerender({ file: "vendor/sub" });
    await waitFor(() => expect(result.current.content).toBe(PATCH_B));

    expect(seen.some((r) => r.file === "vendor/sub" && r.content === PATCH_A)).toBe(false);
    expect(seen.some((r) => r.file === "a.ts" && r.content === PATCH_B)).toBe(false);
  });

  it("fetches once per subject rather than looping on its own output", async () => {
    requestDiffMock.mockResolvedValue({ content: PATCH_A });

    const { result } = renderHook(() => useDiffContent(useSubject("a.ts")));
    await waitFor(() => expect(result.current.content).toBe(PATCH_A));

    expect(requestDiffMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed fetch as ERROR", async () => {
    requestDiffMock.mockRejectedValue(new Error("git exploded"));

    const { result } = renderHook(() => useDiffContent(useSubject("a.ts")));

    await waitFor(() => expect(result.current.content).toBe("ERROR"));
  });

  it("prefetches the next file once the current diff has landed", async () => {
    vi.useFakeTimers();
    requestDiffMock.mockResolvedValue({ content: PATCH_A });
    const next: DiffSubject = {
      source: "working-tree",
      worktreePath: "/repo",
      filePath: "b.ts",
      status: "modified",
    };

    renderHook(() => useDiffContent(useSubject("a.ts"), next));
    await settlePrefetch();

    expect(requestDiffMock.mock.calls.map(([s]) => s.filePath)).toEqual(["a.ts", "b.ts"]);
  });

  it.each<DiffSubject>([
    {
      source: "base-branch",
      worktreePath: "/repo",
      filePath: "b.ts",
      baseBranch: "main",
      currentBranch: "feature",
    },
    {
      source: "since-review",
      worktreePath: "/repo",
      worktreeId: "wt-1",
      filePath: "b.ts",
      side: undefined,
      markRevision: 1,
    },
  ])("never prefetches a $source diff, which the cache would not keep", async (next) => {
    vi.useFakeTimers();
    requestDiffMock.mockResolvedValue({ content: PATCH_A });

    renderHook(() => useDiffContent(useSubject("a.ts"), next));
    await settlePrefetch();

    expect(requestDiffMock.mock.calls.map(([s]) => s.filePath)).toEqual(["a.ts"]);
  });

  it("holds no content for a null subject", () => {
    const { result } = renderHook(() => useDiffContent(null));

    expect(result.current.content).toBeUndefined();
    expect(requestDiffMock).not.toHaveBeenCalled();
  });
});
