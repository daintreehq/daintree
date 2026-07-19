// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useContext } from "react";

import {
  buildCacheKey,
  setCache,
  getCache,
  getGeneration,
  _resetForTests as resetCache,
} from "@/lib/forgeResourceCache";
import { useProjectStore } from "@/store/projectStore";
import { wakeActiveWorktreeTerminals } from "@/store/wakeActiveWorktreeTerminals";
import type { CIStatusState, PR } from "@shared/types/forge";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { Project } from "@shared/types/project";

vi.mock("@/store/wakeActiveWorktreeTerminals", () => ({
  wakeActiveWorktreeTerminals: vi.fn(() => Promise.resolve()),
}));

const wakeMock = vi.mocked(wakeActiveWorktreeTerminals);

// Host-minted `(epoch, seq)` versions (#8403). The mock host uses a fixed
// epoch; `get-all-states` reports seq 0 and push events advance the seq.
const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

type PortEventName =
  | "worktree-update"
  | "worktree-removed"
  | "worktree-activated"
  | "pr-detected"
  | "pr-cleared"
  | "pr-detection-state"
  | "issue-detected"
  | "issue-not-found";

const listeners = new Map<PortEventName, Set<(data: unknown) => void>>();

function emit(name: PortEventName, data: unknown): void {
  const set = listeners.get(name);
  if (!set) return;
  for (const cb of set) cb(data);
}

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name: id,
    isCurrent: false,
    branch: "main",
    isMainWorktree: true,
    prNumber: 42,
    prUrl: "https://example.test/pr/42",
    prState: "open",
    prCiStatus: "pending",
    ...overrides,
  } as WorktreeSnapshot;
}

function makePR(number: number, ciStatus?: CIStatusState): PR {
  return {
    number,
    title: `PR #${number}`,
    body: "",
    url: `https://example.test/pr/${number}`,
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    baseRef: "main",
    headRef: `pr-${number}`,
    createdAt: 0,
    updatedAt: 0,
    ciStatus,
    rawData: null,
  };
}

function setCurrentProject(path: string | null): void {
  const project = path ? ({ id: "p1", name: "p1", path } as unknown as Project) : null;
  useProjectStore.setState({ currentProject: project });
}

beforeEach(() => {
  listeners.clear();
  resetCache();
  setCurrentProject("/repo/proj");
  _seq = 0;

  (globalThis as unknown as { window: Window }).window.electron = {
    worktreePort: {
      isReady: () => true,
      request: (_name: string) =>
        Promise.resolve({ states: [] as WorktreeSnapshot[], epoch: TEST_EPOCH, seq: 0 }),
      onEvent: (name: PortEventName, cb: (data: unknown) => void) => {
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
  resetCache();
  setCurrentProject(null);
});

async function renderProvider() {
  const { WorktreeStoreProvider, WorktreeStoreContext } = await import("../WorktreeStoreContext");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WorktreeStoreProvider>{children}</WorktreeStoreProvider>
  );
  const { result } = renderHook(() => useContext(WorktreeStoreContext), { wrapper });
  // Let the initial fetchInitialState promise chain resolve so the store is
  // marked initialized before the test body runs.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!result.current) throw new Error("WorktreeStoreContext is null");
  return result.current;
}

describe("WorktreeStoreProvider pr-detected handler", () => {
  it("writes prCiStatus to the worktree store", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1"), nextV());
    });

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        prCiStatus: "success",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("success");
  });

  it("clears prCiStatus when the event omits it (full-replace, matches backend)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { prCiStatus: "failure" }), nextV());
    });

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBeUndefined();
  });

  it("leaves the dropdown's PR cache untouched", async () => {
    // This handler used to one-way-patch the renderer's forge cache to keep the
    // sidebar badge and the dropdown row aligned. It couldn't: the patch never
    // reached main's forgePRListCache, so the next revalidate restored the
    // coarse rollup and the surfaces disagreed again. Both now derive CI status
    // from one place — listPRsImpl enriches through the same
    // getCIStatusesImpl/prRequiredStatusCache this event's status comes from —
    // so the handler owns the worktree store only (#11251). Reinstating a
    // cache write here would rebuild the drift this test guards against.
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1"), nextV());
    });

    const key = buildCacheKey("/repo/proj", "pr", "open", "created");
    setCache(key, {
      items: [makePR(42, "pending")],
      nextCursor: null,
      hasMore: false,
      timestamp: 1,
    });
    const genBefore = getGeneration(key);

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "closed",
        prCiStatus: "failure",
      });
    });

    // The worktree store still takes the update...
    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("failure");
    // ...while the cached row keeps both its CI status and its slot. A stale
    // row is corrected by the dropdown's own revalidate, not from here.
    expect((getCache(key)?.items[0] as PR).ciStatus).toBe("pending");
    expect(getCache(key)?.items).toHaveLength(1);
    expect(getGeneration(key)).toBe(genBefore);
  });

  it("applies last-write-wins across rapid successive events for the same PR", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1"), nextV());
    });

    act(() => {
      for (const ciStatus of ["pending", "failure", "success"] as const) {
        emit("pr-detected", {
          type: "pr-detected",
          worktreeId: "wt-1",
          prNumber: 42,
          prUrl: "https://example.test/pr/42",
          prState: "open",
          prCiStatus: ciStatus,
        });
      }
    });

    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("success");
  });

  it("does nothing when the worktree is not in the store", async () => {
    const store = await renderProvider();
    const key = buildCacheKey("/repo/proj", "pr", "open", "created");
    setCache(key, {
      items: [makePR(42, "pending")],
      nextCursor: null,
      hasMore: false,
      timestamp: 1,
    });
    const genBefore = getGeneration(key);

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-missing",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        prCiStatus: "success",
      });
    });

    expect(store.getState().worktrees.get("wt-missing")).toBeUndefined();
    expect((getCache(key)?.items[0] as PR).ciStatus).toBe("pending");
    expect(getGeneration(key)).toBe(genBefore);
  });

  it("drops the overlay when event.branchName mismatches the worktree's current branch", async () => {
    const store = await renderProvider();
    act(() => {
      store
        .getState()
        .applyUpdate(
          makeWorktree("wt-1", { branch: "feature/bar", prCiStatus: "failure", prNumber: 99 }),
          nextV()
        );
    });

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        prCiStatus: "success",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.prNumber).toBe(99);
    expect(wt?.prCiStatus).toBe("failure");
  });

  it("applies the overlay when event.branchName matches the worktree's current branch", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/foo" }), nextV());
    });

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        prCiStatus: "success",
        branchName: "feature/foo",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("success");
  });

  it("applies the overlay when the event omits branchName (older host backward compat)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/foo" }), nextV());
    });

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        prCiStatus: "success",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("success");
  });

  it("drops a stale pr-detected that arrives after a worktree-update changed the branch", async () => {
    // End-to-end race scenario: worktree starts on feature/foo, a PR lookup
    // was queued against it, the worktree switches to feature/bar (arrives as
    // a worktree-update snapshot), then the stale pr-detected from the
    // feature/foo lookup completes and tries to land on the now-bar row.
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/foo" }), nextV());
    });

    // Worktree-update arrives reflecting the branch change to feature/bar.
    act(() => {
      emit("worktree-update", {
        type: "worktree-update",
        worktree: makeWorktree("wt-1", { branch: "feature/bar", prCiStatus: undefined }),
        ...nextV(),
      });
    });

    // The stale pr-detected from the feature/foo lookup arrives late.
    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 999,
        prUrl: "https://example.test/pr/999",
        prState: "open",
        prCiStatus: "failure",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.branch).toBe("feature/bar");
    expect(wt?.prNumber).not.toBe(999);
    expect(wt?.prCiStatus).not.toBe("failure");
  });

  it("applies the overlay when the worktree has no branch (detached HEAD)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: undefined }), nextV());
    });

    act(() => {
      emit("pr-detected", {
        type: "pr-detected",
        worktreeId: "wt-1",
        prNumber: 42,
        prUrl: "https://example.test/pr/42",
        prState: "open",
        prCiStatus: "success",
        branchName: "feature/foo",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("success");
  });
});

describe("WorktreeStoreProvider pr-cleared handler", () => {
  it("drops the clear when event.branchName mismatches the worktree's current branch", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-1", {
          branch: "feature/bar",
          prNumber: 42,
          prUrl: "https://example.test/pr/42",
          prState: "open",
        }),
        nextV()
      );
    });

    act(() => {
      emit("pr-cleared", {
        type: "pr-cleared",
        worktreeId: "wt-1",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.prNumber).toBe(42);
    expect(wt?.prUrl).toBe("https://example.test/pr/42");
    expect(wt?.prState).toBe("open");
  });

  it("applies the clear when event.branchName matches the worktree's current branch", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-1", {
          branch: "feature/foo",
          prNumber: 42,
          prUrl: "https://example.test/pr/42",
          prState: "open",
        }),
        nextV()
      );
    });

    act(() => {
      emit("pr-cleared", {
        type: "pr-cleared",
        worktreeId: "wt-1",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.prNumber).toBeUndefined();
    expect(wt?.prUrl).toBeUndefined();
    expect(wt?.prState).toBeUndefined();
  });

  it("applies the clear when the event omits branchName (older host backward compat)", async () => {
    const store = await renderProvider();
    act(() => {
      store
        .getState()
        .applyUpdate(makeWorktree("wt-1", { branch: "feature/foo", prNumber: 42 }), nextV());
    });

    act(() => {
      emit("pr-cleared", {
        type: "pr-cleared",
        worktreeId: "wt-1",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.prNumber).toBeUndefined();
  });

  it("clears prCiStatus alongside the PR fields (no orphaned CI rollup)", async () => {
    const store = await renderProvider();
    act(() => {
      store
        .getState()
        .applyUpdate(
          makeWorktree("wt-1", { branch: "feature/foo", prNumber: 42, prCiStatus: "failure" }),
          nextV()
        );
    });

    act(() => {
      emit("pr-cleared", {
        type: "pr-cleared",
        worktreeId: "wt-1",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.prNumber).toBeUndefined();
    expect(wt?.prCiStatus).toBeUndefined();
  });

  it("drops a stale pr-cleared after a multi-hop branch switch (foo → bar → baz)", async () => {
    const store = await renderProvider();
    // Start on baz with a valid PR (the survivor)
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-1", {
          branch: "feature/baz",
          prNumber: 999,
          prUrl: "https://example.test/pr/999",
          prState: "open",
          prCiStatus: "success",
        }),
        nextV()
      );
    });

    // Stale clear arrives from the long-ago `foo` lookup
    act(() => {
      emit("pr-cleared", {
        type: "pr-cleared",
        worktreeId: "wt-1",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.prNumber).toBe(999);
    expect(wt?.prCiStatus).toBe("success");
  });
});

describe("WorktreeStoreProvider issue-detected handler", () => {
  it("drops the overlay when event.branchName mismatches the worktree's current branch", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-1", {
          branch: "feature/bar",
          issueNumber: 100,
          issueTitle: "Old issue",
        }),
        nextV()
      );
    });

    act(() => {
      emit("issue-detected", {
        type: "issue-detected",
        worktreeId: "wt-1",
        issueNumber: 200,
        issueTitle: "New issue",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(100);
    expect(wt?.issueTitle).toBe("Old issue");
  });

  it("applies the overlay when event.branchName matches the worktree's current branch", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/foo" }), nextV());
    });

    act(() => {
      emit("issue-detected", {
        type: "issue-detected",
        worktreeId: "wt-1",
        issueNumber: 200,
        issueTitle: "Issue title",
        branchName: "feature/foo",
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(200);
    expect(wt?.issueTitle).toBe("Issue title");
  });

  it("applies the overlay when the event omits branchName (older host backward compat)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/foo" }), nextV());
    });

    act(() => {
      emit("issue-detected", {
        type: "issue-detected",
        worktreeId: "wt-1",
        issueNumber: 200,
        issueTitle: "Issue title",
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(200);
  });

  it("passes a non-GitHub linked projection through without collapsing to defaults (#8452)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/widget" }), nextV());
    });

    act(() => {
      emit("issue-detected", {
        type: "issue-detected",
        worktreeId: "wt-1",
        issueNumber: 88,
        issueTitle: "Widget request",
        branchName: "feature/widget",
        providerId: "acme.gitlab",
        linked: {
          providerId: "acme.gitlab",
          issue: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 88,
              rawData: null,
            },
            title: "Widget request",
          },
        },
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(88);
    expect(wt?.linked?.providerId).toBe("acme.gitlab");
    expect(wt?.linked?.issue?.ref.owner).toBe("acme-corp");
    expect(wt?.linked?.issue?.ref.repo).toBe("my-project");
    expect(wt?.linked?.issue?.ref.number).toBe(88);
  });

  it("preserves an existing PR linkage carried in the host-built issue linked payload", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(makeWorktree("wt-1", { branch: "feature/widget" }), nextV());
    });

    act(() => {
      emit("issue-detected", {
        type: "issue-detected",
        worktreeId: "wt-1",
        issueNumber: 88,
        issueTitle: "Widget request",
        branchName: "feature/widget",
        providerId: "acme.gitlab",
        linked: {
          providerId: "acme.gitlab",
          issue: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 88,
              rawData: null,
            },
            title: "Widget request",
          },
          pr: {
            ref: {
              providerId: "acme.gitlab",
              owner: "acme-corp",
              repo: "my-project",
              number: 1234,
              rawData: null,
            },
            url: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
            state: "open",
          },
        },
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked?.pr?.ref.number).toBe(1234);
    expect(wt?.linked?.issue?.ref.number).toBe(88);
  });

  it("issue-not-found clears linked.issue but preserves linked.pr (#8452)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-1", {
          branch: "feature/widget",
          issueNumber: 88,
          issueTitle: "Widget request",
          linked: {
            providerId: "acme.gitlab",
            issue: {
              ref: {
                providerId: "acme.gitlab",
                owner: "acme-corp",
                repo: "my-project",
                number: 88,
                rawData: null,
              },
              title: "Widget request",
            },
            pr: {
              ref: {
                providerId: "acme.gitlab",
                owner: "acme-corp",
                repo: "my-project",
                number: 1234,
                rawData: null,
              },
              url: "https://gitlab.acme.com/acme-corp/my-project/-/merge_requests/1234",
              state: "open",
            },
          },
        }),
        nextV()
      );
    });

    act(() => {
      emit("issue-not-found", {
        type: "issue-not-found",
        worktreeId: "wt-1",
        issueNumber: 88,
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    // issueNumber survives a not-found response — the local branch-parsed
    // value is authoritative, not the forge claim (#8851).
    expect(wt?.issueNumber).toBe(88);
    expect(wt?.issueTitle).toBeUndefined();
    expect(wt?.linked?.issue).toBeUndefined();
    expect(wt?.linked?.pr?.ref.number).toBe(1234);
  });

  it("issue-not-found preserves branchDerivedTitle so the sidebar still has a readable fallback (#8851)", async () => {
    const store = await renderProvider();
    act(() => {
      store.getState().applyUpdate(
        makeWorktree("wt-1", {
          branch: "feature/issue-8851-sidebar",
          issueNumber: 8851,
          issueTitle: undefined,
          branchDerivedTitle: "Sidebar shows branch",
        }),
        nextV()
      );
    });

    act(() => {
      emit("issue-not-found", {
        type: "issue-not-found",
        worktreeId: "wt-1",
        issueNumber: 8851,
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(8851);
    expect(wt?.branchDerivedTitle).toBe("Sidebar shows branch");
    expect(wt?.issueTitle).toBeUndefined();
  });
});

describe("WorktreeStoreProvider manual issue associations (#8079)", () => {
  function mockHydration(
    states: WorktreeSnapshot[],
    associations: Record<string, { issueNumber: number; issueTitle?: string }>
  ): void {
    const electron = (globalThis as unknown as { window: Window }).window.electron as unknown as {
      worktreePort: { request: (name: string) => Promise<unknown> };
      worktree: { getAllIssueAssociations: () => Promise<unknown> };
    };
    electron.worktreePort.request = () => Promise.resolve({ states, epoch: TEST_EPOCH, seq: 0 });
    electron.worktree.getAllIssueAssociations = () => Promise.resolve(associations);
  }

  it("manual association survives a worktree-update that omits the issue", async () => {
    mockHydration([makeWorktree("wt-1", { issueNumber: undefined, issueTitle: undefined })], {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });
    const store = await renderProvider();

    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(42);

    act(() => {
      emit("worktree-update", {
        type: "worktree-update",
        worktree: makeWorktree("wt-1", {
          branch: "feature/x",
          issueNumber: undefined,
          issueTitle: undefined,
        }),
        ...nextV(),
      });
    });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(wt?.branch).toBe("feature/x");
  });

  it("manual association overrides an auto-detected issue (MANUAL_OVER_AUTO)", async () => {
    mockHydration([makeWorktree("wt-1", { issueNumber: 11, issueTitle: "Auto" })], {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });
    const store = await renderProvider();

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
  });

  it("clearing an association stops it resurfacing on the next update", async () => {
    mockHydration([makeWorktree("wt-1", { issueNumber: undefined })], {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });
    const store = await renderProvider();

    act(() => {
      store.getState().clearManualAssociation("wt-1");
    });
    act(() => {
      emit("worktree-update", {
        type: "worktree-update",
        worktree: makeWorktree("wt-1", { issueNumber: undefined, issueTitle: undefined }),
        ...nextV(),
      });
    });

    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBeUndefined();
  });
});

describe("WorktreeStoreProvider visibilitychange (#8066 consolidation)", () => {
  it("does not call worktreePort.request on visibilitychange after migration", async () => {
    const requestMock = vi.fn(() =>
      Promise.resolve({ states: [] as WorktreeSnapshot[], epoch: TEST_EPOCH, seq: 0 })
    );
    const electron = (globalThis as unknown as { window: Window }).window.electron as unknown as {
      worktreePort: { request: (name: string) => Promise<unknown> };
    };
    electron.worktreePort.request = requestMock;

    await renderProvider();

    // Mount fetch: `get-all-states` request fires once during provider setup.
    const initialCallCount = requestMock.mock.calls.length;
    expect(initialCallCount).toBeGreaterThanOrEqual(1);

    // A visibilitychange must NOT trigger another `get-all-states` request —
    // sleep-wake refresh is now coordinated via `useSystemWakeStore.wakeEpoch`
    // and the workspace host's `refreshOnWake` push events.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestMock.mock.calls.length).toBe(initialCallCount);
  });
});

describe("WorktreeStoreProvider resume event (#9702)", () => {
  const rafQueue: FrameRequestCallback[] = [];
  const realRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    rafQueue.length = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof globalThis.requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
  });

  // The wake fan-out is deferred behind a double-rAF so it runs after the
  // unfrozen renderer's first settled layout pass (#10362).
  function flushWakeFrames(): void {
    for (let i = 0; i < 2; i++) {
      act(() => {
        const pending = rafQueue.splice(0, rafQueue.length);
        for (const cb of pending) cb(0);
      });
    }
  }

  function setVisibility(state: "visible" | "hidden"): void {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
  }

  it("does not wake when resume fires while the document is hidden", async () => {
    setVisibility("hidden");
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("resume"));
    });
    flushWakeFrames();

    expect(wakeMock).not.toHaveBeenCalled();
  });

  it("wakes once when resume fires while visible", async () => {
    setVisibility("visible");
    await renderProvider();
    wakeMock.mockClear();

    act(() => {
      document.dispatchEvent(new Event("resume"));
    });
    flushWakeFrames();

    expect(wakeMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces a resume + visibilitychange pair into a single wake", async () => {
    setVisibility("visible");
    await renderProvider();
    wakeMock.mockClear();

    // Chromium fires resume immediately before visibilitychange on thaw; both
    // land in the same turn and must collapse to one fan-out.
    act(() => {
      document.dispatchEvent(new Event("resume"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    flushWakeFrames();

    expect(wakeMock).toHaveBeenCalledTimes(1);
  });
});

describe("WorktreeStoreProvider host restart re-hydration (#8403)", () => {
  it("a new-epoch event triggers a re-hydrate that replaces the stale tree", async () => {
    const store = await renderProvider();
    // Initialized under TEST_EPOCH with a stale worktree.
    act(() => {
      store.getState().applyUpdate(makeWorktree("old-1"), nextV());
    });
    expect(store.getState().worktrees.has("old-1")).toBe(true);

    // Host restarts: get-all-states now answers under a new epoch with the
    // authoritative post-restart tree. The new-epoch push event's seq matches
    // the high-water seq the snapshot reports — the equal-seq snapshot must
    // still apply, or the re-hydrate is silently swallowed (review finding #2).
    const electron = (globalThis as unknown as { window: Window }).window.electron as unknown as {
      worktreePort: { request: (name: string) => Promise<unknown> };
    };
    electron.worktreePort.request = () =>
      Promise.resolve({
        states: [makeWorktree("post-1"), makeWorktree("post-2")],
        epoch: "epoch-restarted",
        seq: 1,
      });

    await act(async () => {
      emit("worktree-update", {
        type: "worktree-update",
        worktree: makeWorktree("post-1"),
        epoch: "epoch-restarted",
        seq: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.getState().worktrees.has("old-1")).toBe(false);
    expect(store.getState().worktrees.has("post-2")).toBe(true);
    expect(store.getState().version.epoch).toBe("epoch-restarted");
  });
});
