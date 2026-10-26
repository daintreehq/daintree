// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import { useProjectStore } from "@/store/projectStore";
import { useDiffViewedStore, selectViewedSet } from "@/store/diffViewedStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import {
  resetStoreAccessorsForTesting,
  setViewedMarkSourcesAccessor,
} from "@/store/storeAccessors";
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
const MAIN_PATH = "/repo";

interface Shape {
  entries?: Array<Partial<FileChangeDetail> & { path: string }>;
  headOid?: string;
}

// The store keeps a snapshot's identity unless an aggregate moves, so these
// are filled in the way the host computes them.
function snapshot(id: string, path: string, branch: string, shape: Shape) {
  const changes: FileChangeDetail[] = (shape.entries ?? []).map((entry) => ({
    status: "modified",
    insertions: 1,
    deletions: 0,
    mtimeMs: 100,
    ...entry,
    path: `${path}/${entry.path}`,
  }));
  return {
    id,
    worktreeId: id,
    path,
    name: id,
    isCurrent: false,
    isMainWorktree: path === MAIN_PATH,
    branch,
    worktreeChanges: {
      worktreeId: id,
      rootPath: path,
      changedFileCount: changes.length,
      changes,
      totalInsertions: changes.reduce((sum, change) => sum + (change.insertions ?? 0), 0),
      totalDeletions: changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0),
      latestFileMtime: Math.max(0, ...changes.map((change) => change.mtimeMs ?? 0)),
      headOid: shape.headOid ?? "head-1",
    },
  } as WorktreeSnapshot;
}

const feature = (shape: Shape) => snapshot("wt-1", WT_PATH, "feature", shape);
const main = (shape: Shape = {}) =>
  snapshot("main", MAIN_PATH, "main", { headOid: "base-1", ...shape });

function emitUpdate(worktree: WorktreeSnapshot): void {
  act(() => {
    for (const cb of listeners.get("worktree-update") ?? []) {
      cb({ type: "worktree-update", worktree, ...nextV() });
    }
  });
}

const viewed = (key: string) => selectViewedSet(useDiffViewedStore.getState(), WT_PATH).has(key);

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
  async function seed(...worktrees: WorktreeSnapshot[]) {
    const store = await renderProvider();
    act(() => {
      store.getState().applySnapshot(worktrees, nextV());
    });
  }

  function mark(key: string) {
    useDiffViewedStore.getState().setViewed(WT_PATH, key, true);
    expect(viewed(key)).toBe(true);
  }

  it("lapses a mark once a poll shows its file changed, and keeps the rest", async () => {
    await seed(main(), feature({ entries: [{ path: "a.ts" }, { path: "b.ts" }] }));
    mark("modified:a.ts");
    mark("modified:b.ts");

    emitUpdate(feature({ entries: [{ path: "a.ts", mtimeMs: 200 }, { path: "b.ts" }] }));

    expect(viewed("modified:a.ts")).toBe(false);
    expect(viewed("modified:b.ts")).toBe(true);
  });

  it("lapses a mark when the agent's own commit takes the file out of the change list", async () => {
    await seed(main(), feature({ entries: [{ path: "a.ts" }] }));
    mark("unstaged:a.ts");

    emitUpdate(feature({ entries: [], headOid: "head-2" }));
    expect(viewed("unstaged:a.ts")).toBe(false);

    emitUpdate(feature({ entries: [{ path: "a.ts" }], headOid: "head-2" }));
    expect(viewed("unstaged:a.ts")).toBe(false);
  });

  it("lapses a base-branch mark when only the main worktree's HEAD moves", async () => {
    await seed(main(), feature({ entries: [{ path: "a.ts" }] }));
    mark("base:a.ts");

    emitUpdate(main({ headOid: "base-2" }));

    expect(viewed("base:a.ts")).toBe(false);
  });
});
