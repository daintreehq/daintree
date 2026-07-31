// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffSubject } from "../diffContentCache";

const dispatchMock = vi.hoisted(() =>
  vi.fn<(id: string, args: unknown, opts: unknown) => Promise<{ ok: true; result: unknown }>>()
);
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

import { _resetDiffCacheForTests, peekCachedDiff, requestDiff } from "../diffContentCache";

const compareWorktreesMock = vi.fn<(...args: unknown[]) => Promise<string>>();

function workingTree(filePath: string): DiffSubject {
  return { source: "working-tree", worktreePath: "/repo", filePath, status: "modified" };
}

function baseBranch(filePath: string): DiffSubject {
  return {
    source: "base-branch",
    worktreePath: "/repo",
    filePath,
    baseBranch: "main",
    currentBranch: "feature/x",
  };
}

beforeEach(() => {
  _resetDiffCacheForTests();
  dispatchMock
    .mockReset()
    .mockResolvedValue({ ok: true, result: { content: "diff body", truncated: false } });
  compareWorktreesMock.mockReset().mockResolvedValue("base diff body");
  Object.assign(window, { electron: { git: { compareWorktrees: compareWorktreesMock } } });
});

describe("diffContentCache — base-branch subjects are never cached", () => {
  it("refetches a base-branch diff every time it is requested", async () => {
    await requestDiff(baseBranch("src/a.ts"), false);
    await requestDiff(baseBranch("src/a.ts"), false);

    // The key is `baseBranch + currentBranch` — branch names, which say nothing
    // about content, so a serve-from-cache here would show a pre-`main`-advance
    // diff with no stale banner to correct it.
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
    expect(peekCachedDiff(baseBranch("src/a.ts"), false)).toBeUndefined();
  });

  it("still dedups two base-branch requests that overlap in flight", async () => {
    const first = requestDiff(baseBranch("src/a.ts"), false);
    const second = requestDiff(baseBranch("src/a.ts"), false);
    const [a, b] = await Promise.all([first, second]);

    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("keeps caching working-tree subjects", async () => {
    await requestDiff(workingTree("src/a.ts"), false);
    await requestDiff(workingTree("src/a.ts"), false);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});

describe("diffContentCache — diff windowing (#11531)", () => {
  it("requests the full 1MB transport ceiling, not the agent-facing default window", async () => {
    await requestDiff(workingTree("src/a.ts"), false);

    expect(dispatchMock).toHaveBeenCalledWith(
      "git.getFileDiff",
      expect.objectContaining({ maxBytes: 1024 * 1024 }),
      expect.anything()
    );
  });

  it("maps a truncated window back onto the FILE_TOO_LARGE sentinel the panes render", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      result: { content: "first megabyte", truncated: true, nextOffset: 1024 * 1024 },
    });

    const result = await requestDiff(workingTree("src/huge.ts"), false);

    expect(result?.content).toBe("FILE_TOO_LARGE");
  });

  it("passes an untruncated diff through unchanged", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      result: { content: "small diff", truncated: false, nextOffset: null },
    });

    const result = await requestDiff(workingTree("src/small.ts"), false);

    expect(result?.content).toBe("small diff");
  });
});

describe("diffContentCache — eviction order", () => {
  /** Inserts after the first entry needed to evict it — i.e. the capacity. */
  async function measureCapacity(): Promise<number> {
    await requestDiff(workingTree("f0.ts"), false);
    let inserts = 0;
    while (peekCachedDiff(workingTree("f0.ts"), false) !== undefined) {
      inserts++;
      if (inserts > 500) throw new Error("cache never evicted its oldest entry");
      await requestDiff(workingTree(`f${inserts}.ts`), false);
    }
    return inserts;
  }

  it("evicts least-recently-used, not first-inserted", async () => {
    const capacity = await measureCapacity();
    _resetDiffCacheForTests();

    // Fill exactly to capacity, oldest first: f0 is next out under either policy.
    await requestDiff(workingTree("f0.ts"), false);
    for (let i = 1; i < capacity; i++) {
      await requestDiff(workingTree(`f${i}.ts`), false);
    }

    // Read f0 back. Under FIFO this changes nothing; under LRU it moves f0 to
    // the young end and makes f1 the eviction candidate.
    await requestDiff(workingTree("f0.ts"), false);
    await requestDiff(workingTree("fresh.ts"), false);

    expect(peekCachedDiff(workingTree("f0.ts"), false)).toBeDefined();
    expect(peekCachedDiff(workingTree("f1.ts"), false)).toBeUndefined();
  });
});
