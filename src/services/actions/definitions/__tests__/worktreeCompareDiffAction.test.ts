import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { AnyActionDefinition } from "../../actionTypes";
import type { CrossWorktreeDiffResult } from "@shared/types/ipc/git";

const mockGetCurrentViewStore = vi.fn();
const mockOpenCrossWorktreeDiff = vi.fn();

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => mockGetCurrentViewStore(),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({ openCrossWorktreeDiff: mockOpenCrossWorktreeDiff }),
  },
}));
vi.mock("@/store/uiStore", () => ({ useUIStore: { getState: vi.fn(() => ({})) } }));
vi.mock("@/lib/copyTreeFormat", () => ({ DEFAULT_COPYTREE_FORMAT: "xml" }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

import { registerWorktreeContextActions } from "../worktreeContextActions";

type ActionFactory = () => AnyActionDefinition;

const SAMPLE_RESULT: CrossWorktreeDiffResult = {
  branch1: "feature/a",
  branch2: "feature/b",
  files: [{ path: "src/app.ts", status: "M", insertions: 3, deletions: 1 }],
};

const mockCompareWorktrees = vi.fn();

function setWorktrees(entries: Array<{ id: string; path: string; branch?: string }>): void {
  const map = new Map(entries.map((e) => [e.id, e]));
  mockGetCurrentViewStore.mockReturnValue({ getState: () => ({ worktrees: map }) });
}

function getRun(): AnyActionDefinition["run"] {
  const registry = new Map<string, ActionFactory>();
  registerWorktreeContextActions(registry as never, { onInject: vi.fn() } as never);
  return registry.get("worktree.compareDiff")!().run;
}

describe("worktree.compareDiff run() (#10684)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompareWorktrees.mockResolvedValue(SAMPLE_RESULT);
    // @ts-expect-error - minimal window.electron stub for the renderer IPC call
    globalThis.window = { electron: { git: { compareWorktrees: mockCompareWorktrees } } };
    setWorktrees([
      { id: "wt-left", path: "/repo/left", branch: "feature/a" },
      { id: "wt-right", path: "/repo/right", branch: "feature/b" },
    ]);
  });

  afterEach(() => {
    // @ts-expect-error - tear down the stub so it doesn't leak to other suites
    delete globalThis.window;
  });

  it("returns the cross-worktree diff result for two explicit worktrees", async () => {
    const run = getRun();
    const result = await run(
      { worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never,
      {} as ActionContext
    );
    expect(result).toEqual({
      ...SAMPLE_RESULT,
      total: 1,
      hasMore: false,
      offset: 0,
      limit: 100,
      nextOffset: null,
    });
    expect(mockCompareWorktrees).toHaveBeenCalledWith(
      "/repo/left",
      "feature/a",
      "feature/b",
      undefined,
      undefined,
      undefined
    );
    // It must NOT open the UI modal when invoked programmatically.
    expect(mockOpenCrossWorktreeDiff).not.toHaveBeenCalled();
  });

  it("forwards useMergeBase and ignoreWhitespace flags to the IPC call", async () => {
    const run = getRun();
    await run(
      {
        worktreeId: "wt-left",
        compareToWorktreeId: "wt-right",
        useMergeBase: true,
        ignoreWhitespace: true,
      } as never,
      {} as ActionContext
    );
    expect(mockCompareWorktrees).toHaveBeenCalledWith(
      "/repo/left",
      "feature/a",
      "feature/b",
      undefined,
      true,
      true
    );
  });

  it("falls back to focusedWorktreeId for the base side when worktreeId is omitted", async () => {
    const run = getRun();
    await run(
      { compareToWorktreeId: "wt-right" } as never,
      { focusedWorktreeId: "wt-left" } as ActionContext
    );
    expect(mockCompareWorktrees).toHaveBeenCalledWith(
      "/repo/left",
      "feature/a",
      "feature/b",
      undefined,
      undefined,
      undefined
    );
  });

  it("falls back to activeWorktreeId when neither arg nor focus is present", async () => {
    const run = getRun();
    await run(
      { compareToWorktreeId: "wt-right" } as never,
      { activeWorktreeId: "wt-left" } as ActionContext
    );
    expect(mockCompareWorktrees).toHaveBeenCalledWith(
      "/repo/left",
      "feature/a",
      "feature/b",
      undefined,
      undefined,
      undefined
    );
  });

  it("throws when no base worktree can be resolved", async () => {
    const run = getRun();
    await expect(
      run({ compareToWorktreeId: "wt-right" } as never, {} as ActionContext)
    ).rejects.toThrow(/No base worktree/);
    expect(mockCompareWorktrees).not.toHaveBeenCalled();
  });

  it("throws when the base worktree id is unknown", async () => {
    const run = getRun();
    await expect(
      run({ worktreeId: "missing", compareToWorktreeId: "wt-right" } as never, {} as ActionContext)
    ).rejects.toThrow(/Worktree not found: missing/);
  });

  it("throws when the compare-to worktree id is unknown", async () => {
    const run = getRun();
    await expect(
      run({ worktreeId: "wt-left", compareToWorktreeId: "missing" } as never, {} as ActionContext)
    ).rejects.toThrow(/Worktree not found: missing/);
  });

  it("throws when the base side has no branch (detached HEAD)", async () => {
    setWorktrees([
      { id: "wt-left", path: "/repo/left", branch: undefined },
      { id: "wt-right", path: "/repo/right", branch: "feature/b" },
    ]);
    const run = getRun();
    await expect(
      run({ worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never, {} as ActionContext)
    ).rejects.toThrow(/detached HEAD/);
    expect(mockCompareWorktrees).not.toHaveBeenCalled();
  });

  it("throws when the compare-to side has no branch (detached HEAD)", async () => {
    setWorktrees([
      { id: "wt-left", path: "/repo/left", branch: "feature/a" },
      { id: "wt-right", path: "/repo/right", branch: undefined },
    ]);
    const run = getRun();
    await expect(
      run({ worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never, {} as ActionContext)
    ).rejects.toThrow(/detached HEAD/);
    expect(mockCompareWorktrees).not.toHaveBeenCalled();
  });

  it("delegates self-comparison to the IPC (no client-side guard)", async () => {
    // The action does not block worktreeId === compareToWorktreeId; it forwards
    // both (identical) branches to git, which returns an empty file list. This
    // documents that the data contract delegates the equality case downstream.
    const run = getRun();
    await run(
      { worktreeId: "wt-left", compareToWorktreeId: "wt-left" } as never,
      {} as ActionContext
    );
    expect(mockCompareWorktrees).toHaveBeenCalledWith(
      "/repo/left",
      "feature/a",
      "feature/a",
      undefined,
      undefined,
      undefined
    );
  });

  it("throws when the IPC returns a raw diff string instead of a file list", async () => {
    mockCompareWorktrees.mockResolvedValue("raw diff text");
    const run = getRun();
    await expect(
      run({ worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never, {} as ActionContext)
    ).rejects.toThrow(/Unexpected diff string/);
  });

  it("propagates IPC rejection", async () => {
    mockCompareWorktrees.mockRejectedValue(new Error("branch not found"));
    const run = getRun();
    await expect(
      run({ worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never, {} as ActionContext)
    ).rejects.toThrow(/branch not found/);
  });

  describe("bounded file list (#11531)", () => {
    const manyFiles = (count: number) => ({
      branch1: "feature/a",
      branch2: "feature/b",
      files: Array.from({ length: count }, (_, i) => ({
        path: `src/file-${i}.ts`,
        status: "M",
        insertions: 1,
        deletions: 0,
      })),
    });

    it("caps the file list at the default page size rather than returning all of them", async () => {
      mockCompareWorktrees.mockResolvedValue(manyFiles(5000));
      const run = getRun();
      const result = (await run(
        { worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never,
        {} as ActionContext
      )) as { files: unknown[]; total: number; hasMore: boolean; nextOffset: number | null };

      expect(result.files).toHaveLength(100);
      expect(result.total).toBe(5000);
      expect(result.hasMore).toBe(true);
      expect(result.nextOffset).toBe(100);
    });

    it("serves a later page from offset and closes out at the end", async () => {
      mockCompareWorktrees.mockResolvedValue(manyFiles(120));
      const run = getRun();
      const result = (await run(
        { worktreeId: "wt-left", compareToWorktreeId: "wt-right", offset: 100 } as never,
        {} as ActionContext
      )) as { files: { path: string }[]; hasMore: boolean; nextOffset: number | null };

      expect(result.files).toHaveLength(20);
      expect(result.files[0]?.path).toBe("src/file-100.ts");
      expect(result.hasMore).toBe(false);
      expect(result.nextOffset).toBeNull();
    });

    it("clamps an over-ceiling limit reaching run() unvalidated", async () => {
      mockCompareWorktrees.mockResolvedValue(manyFiles(5000));
      const run = getRun();
      const result = (await run(
        { worktreeId: "wt-left", compareToWorktreeId: "wt-right", limit: 99999 } as never,
        {} as ActionContext
      )) as { files: unknown[]; limit: number };

      expect(result.files).toHaveLength(200);
      expect(result.limit).toBe(200);
    });

    it("drops per-file fields the schema does not advertise", async () => {
      mockCompareWorktrees.mockResolvedValue({
        branch1: "a",
        branch2: "b",
        files: [
          { path: "x.ts", status: "M", insertions: 1, deletions: 0, patch: "z".repeat(10_000) },
        ],
      });
      const run = getRun();
      const result = (await run(
        { worktreeId: "wt-left", compareToWorktreeId: "wt-right" } as never,
        {} as ActionContext
      )) as { files: Record<string, unknown>[] };

      expect(result.files[0]).not.toHaveProperty("patch");
      expect(result.files[0]?.path).toBe("x.ts");
    });
  });
});
