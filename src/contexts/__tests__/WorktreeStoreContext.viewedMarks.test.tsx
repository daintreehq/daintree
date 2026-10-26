// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { resetStoreAccessorsForTesting, setViewedMarkSourcesAccessor } from "@/store/storeAccessors";
import type { FileChangeDetail, WorktreeEventVersion, WorktreeSnapshot } from "@shared/types";
import type { Project } from "@shared/types/project";

/**
 * The provider is what turns a worktree poll into an observation for Viewed
 * marks (#14581): a poll that shows a marked file changed lapses its mark.
 */

const TEST_EPOCH = "test-epoch";
let seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++seq };
}

const listeners = new Map<string, Set<(data: unknown) => void>>();

const WT_PATH = "/repo/wt-1";

// The store keeps a snapshot's identity unless an aggregate moves, so these
// are filled in the way the host computes them.
function worktreeWith(entries: Array<Partial<FileChangeDetail> & { path: string }>) {
  const changes: FileChangeDetail[] = entries.map((entry) => ({
    status: "modified",
    insertions: 1,
    deletions: 0,
    mtimeMs: 100,
    ...entry,
    path: `${WT_PATH}/${entry.path}`,
  }));
  return {
    id: "wt-1",
    worktreeId: "wt-1",
    path: WT_PATH,
    name: "wt-1",
    isCurrent: false,
    branch: "feature",
    worktreeChanges: {
      worktreeId: "wt-1",
      rootPath: WT_PATH,
      changedFileCount: changes.length,
      changes,
      totalInsertions: changes.reduce((sum, change) => sum + (change.insertions ?? 0), 0),
      totalDeletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
      latestFileMtime: Math.max(0, ...changes.map((change) => change.mtimeMs ?? 0)),
    },
  } as WorktreeSnapshot;
}

function emitUpdate(worktree: WorktreeSnapshot): void {
  act(() => {
    for (const cb of listeners.get("worktree-update") ?? []) {
      cb({ type: "worktree-update", worktree, ...nextV() });
    }
  });
}

const viewed = (key: string) =>
  selectViewedSet(useDiffViewedStore.getState(), WT_PATH).has(key);

beforeEach(() => {
  listeners.clear();
  seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the path is read
  useProjectStore.setState({ currentProject: { id: "p1", path: "/repo" } as unknown as Project });
  useDiffViewedStore.setState({ viewedByWorktree: {}, baselinesByWorktree: {} });
  setViewedMarkSourcesAccessor(() => ({
    worktrees: getCurrentViewStoreOrNull()?.getState().worktrees ?? null,
    stagingStatus: null,
  }));

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- jsdom global, stubbed per test
  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({ states: [] as WorktreeSnapshot[], epoch: TEST_EPOCH, seq: 0 }),
      onEvent: (name: string, cb: (data: unknown) => void) => {
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(cb);
        return () => set?.delete(cb);
      },
      onReady: (_cb: () => void) => () => {},
      onDisconnected: (_cb: () => void) => () => {},
      onFatalDisconnect: (_cb: () => void) => () => {},
    },
    worktree: {
      getAllIssueAssociations: () => Promise.resolve({}),
      getPRStatus: () => Promise.resolve(null),
    },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  listeners.clear();
  useProjectStore.setState({ currentProject: null });
  resetStoreAccessorsForTesting();
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const rendered = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!rendered.result.current) throw new Error("WorktreeStoreContext is null");
  return rendered.result.current;
}

describe("WorktreeStoreProvider — Viewed marks follow worktree polls (#14581)", () => {
  it("lapses a mark once a poll shows its file changed, and keeps the rest", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applySnapshot([worktreeWith([{ path: "a.ts" }, { path: "b.ts" }])], nextV());
    });
    useDiffViewedStore.getState().setViewed(WT_PATH, "modified:a.ts", true);
    useDiffViewedStore.getState().setViewed(WT_PATH, "modified:b.ts", true);

    emitUpdate(worktreeWith([{ path: "a.ts", mtimeMs: 200 }, { path: "b.ts" }]));

    expect(viewed("modified:a.ts")).toBe(false);
    expect(viewed("modified:b.ts")).toBe(true);
  });

  it("lapses a mark when the agent's own commit takes the file out of the change list", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applySnapshot([worktreeWith([{ path: "a.ts" }])], nextV());
    });
    useDiffViewedStore.getState().setViewed(WT_PATH, "unstaged:a.ts", true);

    emitUpdate(worktreeWith([]));
    emitUpdate(worktreeWith([{ path: "a.ts" }]));

    expect(viewed("unstaged:a.ts")).toBe(false);
  });
});
