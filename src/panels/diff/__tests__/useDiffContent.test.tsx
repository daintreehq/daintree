// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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

function subject(filePath: string): DiffSubject {
  return { source: "working-tree", worktreePath: "/repo", filePath, status: "modified" };
}

const PATCH_A = "diff --git a/a.ts b/a.ts\nindex 83db48f..bf269f4 100644";
const PATCH_B = "diff --git a/vendor/sub b/vendor/sub\nindex ada605e..029ae62 160000";

beforeEach(() => {
  requestDiffMock.mockReset();
});

describe("useDiffContent", () => {
  it("never reports one file's patch under another file's subject", async () => {
    // Callers read the patch to decide what the new side IS — a gitlink has no
    // readable file (#12309) — so handing back the previous file's patch for
    // even one render lets a whole-file read fire at the wrong path.
    requestDiffMock.mockImplementation(async (s) => ({
      content: s.filePath === "a.ts" ? PATCH_A : PATCH_B,
    }));

    const { result, rerender } = renderHook(({ file }) => useDiffContent(subject(file)), {
      initialProps: { file: "a.ts" },
    });
    await waitFor(() => expect(result.current.content).toBe(PATCH_A));

    rerender({ file: "vendor/sub" });
    // The synchronous read after retargeting: A's patch must already be gone,
    // not merely replaced once an effect runs.
    expect(result.current.content).toBeUndefined();

    await waitFor(() => expect(result.current.content).toBe(PATCH_B));
  });

  it("reports a failed fetch as ERROR for the subject it failed on", async () => {
    requestDiffMock.mockRejectedValue(new Error("git exploded"));

    const { result } = renderHook(() => useDiffContent(subject("a.ts")));

    await waitFor(() => expect(result.current.content).toBe("ERROR"));
  });

  it("holds no content for a null subject", () => {
    const { result } = renderHook(() => useDiffContent(null));

    expect(result.current.content).toBeUndefined();
    expect(requestDiffMock).not.toHaveBeenCalled();
  });
});
