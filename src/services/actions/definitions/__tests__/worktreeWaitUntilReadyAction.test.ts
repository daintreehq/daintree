import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { WorktreeSetupStatus } from "@shared/types/worktree";

const worktreeClientMock = vi.hoisted(() => ({
  getDefaultPath: vi.fn(),
  getAvailableBranch: vi.fn(),
  listBranches: vi.fn().mockResolvedValue([]),
  getAllWithStatus: vi.fn(),
}));

const viewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));

vi.mock("@/clients", () => ({ worktreeClient: worktreeClientMock }));
vi.mock("@/store/createWorktreeStore", () => viewStoreMock);

import { registerWorktreeQueryActions } from "../worktreeQueryActions";

type Row = { id: string; path?: string; branch?: string; setupStatus?: WorktreeSetupStatus };

/**
 * Seed BOTH authorities: the host read `worktree.waitUntilReady` polls, and the
 * renderer store the listings project from. They are separate on purpose —
 * conflating them is the race the wait was rewritten to avoid.
 */
function setRows(rows: Row[]): void {
  viewStoreMock.getCurrentViewStore.mockReturnValue({
    getState: () => ({ worktrees: new Map(rows.map((r) => [r.id, r])) }),
  });
  worktreeClientMock.getAllWithStatus.mockResolvedValue({ worktrees: rows, gitBacked: true });
}

/** Seed only the host, leaving the renderer store empty. */
function setHostOnlyRows(rows: Row[]): void {
  viewStoreMock.getCurrentViewStore.mockReturnValue({
    getState: () => ({ worktrees: new Map() }),
  });
  worktreeClientMock.getAllWithStatus.mockResolvedValue({ worktrees: rows, gitBacked: true });
}

function callbacks(rows: Row[] = [], activeId: string | null = null): ActionCallbacks {
  return {
    getWorktrees: () => rows as never,
    getActiveWorktreeId: () => activeId,
  } as unknown as ActionCallbacks;
}

function action(id: string, cb: ActionCallbacks): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  registerWorktreeQueryActions(registry, cb);
  const factory = registry.get(id as never);
  if (!factory) throw new Error(`${id} not registered`);
  return factory() as AnyActionDefinition;
}

const READY: WorktreeSetupStatus = { state: "ready", startedAt: 1, completedAt: 2 };

describe("worktree.waitUntilReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRows([]);
  });

  it("returns immediately once setup has settled", async () => {
    setRows([{ id: "wt-1", setupStatus: READY }]);
    const def = action("worktree.waitUntilReady", callbacks());

    const result = (await def.run!({ worktreeId: "wt-1" }, {} as ActionContext)) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({
      worktreeId: "wt-1",
      setupState: "ready",
      stage: null,
      error: null,
      timedOut: false,
    });
  });

  it("reports a failure with the stage that failed rather than a bare error", async () => {
    setRows([
      {
        id: "wt-1",
        setupStatus: {
          state: "failed",
          stage: "submodules",
          startedAt: 1,
          completedAt: 2,
          error: "submodule clone failed",
        },
      },
    ]);
    const def = action("worktree.waitUntilReady", callbacks());

    const result = (await def.run!({ worktreeId: "wt-1" }, {} as ActionContext)) as Record<
      string,
      unknown
    >;

    expect(result.setupState).toBe("failed");
    expect(result.stage).toBe("submodules");
    expect(result.error).toBe("submodule clone failed");
    // A settled failure is an answer, not an expired wait.
    expect(result.timedOut).toBe(false);
  });

  it("settles immediately on unknown rather than waiting for a status that will never arrive", async () => {
    // No recorded status means this host process did not create the worktree,
    // so nothing will ever write one. Blocking would burn the caller's whole
    // timeout to learn what was already knowable on the first read.
    setRows([{ id: "wt-1" }]);
    const def = action("worktree.waitUntilReady", callbacks());

    const started = Date.now();
    const result = (await def.run!(
      { worktreeId: "wt-1", timeoutMs: 20_000 },
      {} as ActionContext
    )) as Record<string, unknown>;

    expect(result.setupState).toBe("unknown");
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports the live state and timedOut when the budget runs out mid-run", async () => {
    setRows([
      { id: "wt-1", setupStatus: { state: "running", stage: "setup-script", startedAt: 1 } },
    ]);
    const def = action("worktree.waitUntilReady", callbacks());

    const result = (await def.run!(
      { worktreeId: "wt-1", timeoutMs: 0 },
      {} as ActionContext
    )) as Record<string, unknown>;

    // A timeout is not a failure: the state it reports is real and the caller
    // is expected to ask again.
    expect(result.setupState).toBe("running");
    expect(result.stage).toBe("setup-script");
    expect(result.timedOut).toBe(true);
  });

  it("stops waiting as soon as the status transitions", async () => {
    setRows([{ id: "wt-1", setupStatus: { state: "running", startedAt: 1 } }]);
    const def = action("worktree.waitUntilReady", callbacks());

    const pending = def.run!({ worktreeId: "wt-1", timeoutMs: 5_000 }, {} as ActionContext);
    setTimeout(() => setRows([{ id: "wt-1", setupStatus: READY }]), 60);

    const result = (await pending) as Record<string, unknown>;
    expect(result.setupState).toBe("ready");
    expect(result.timedOut).toBe(false);
  });

  it("falls back to the active worktree and rejects when there is none", async () => {
    setRows([{ id: "wt-active", setupStatus: READY }]);
    const withActive = action("worktree.waitUntilReady", callbacks([], "wt-active"));
    const result = (await withActive.run!(undefined, {
      activeWorktreeId: "wt-active",
    } as ActionContext)) as Record<string, unknown>;
    expect(result.worktreeId).toBe("wt-active");

    const noActive = action("worktree.waitUntilReady", callbacks());
    // The shared location helper's wording, since this tool now takes the same
    // selectors as every other worktree-scoped one.
    await expect(noActive.run!(undefined, {} as ActionContext)).rejects.toThrow(
      /No active worktree/
    );
  });

  it("rejects a worktree the host does not have at all", async () => {
    // Distinct from `unknown`: that one exists but has no recorded setup, while
    // this one is a bad id, and answering "unknown" for it would look like a
    // real worktree nobody had set up.
    setRows([]);
    const def = action("worktree.waitUntilReady", callbacks());
    // Static text: the rejected id is the caller's own argument, and the
    // repo-wide rule is that an error never echoes its input back out.
    await expect(def.run!({ worktreeId: "nope" }, {} as ActionContext)).rejects.toThrow(
      /Unknown worktree/
    );
    await expect(def.run!({ worktreeId: "nope" }, {} as ActionContext)).rejects.not.toThrow(/nope/);
  });

  it("asks the HOST, not the renderer store, so a fresh create is never misread", async () => {
    // The race this exists to close: worktree rows reach the renderer over the
    // project port while a create answers on the parent-process transport, with
    // no ordering between them. A wait issued immediately after a create can
    // therefore find no store row — and reporting `unknown` there is the one
    // answer that must never happen, because `unknown` settles the wait and
    // reads as "nothing will ever arrive" for a worktree that is mid-setup.
    setHostOnlyRows([
      { id: "wt-1", setupStatus: { state: "running", stage: "submodules", startedAt: 1 } },
    ]);
    const def = action("worktree.waitUntilReady", callbacks());

    const result = (await def.run!(
      { worktreeId: "wt-1", timeoutMs: 0 },
      {} as ActionContext
    )) as Record<string, unknown>;

    expect(worktreeClientMock.getAllWithStatus).toHaveBeenCalled();
    expect(result.setupState).toBe("running");
    expect(result.stage).toBe("submodules");
  });
});

describe("worktree listings carry the setup state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports `unknown` for a worktree this app did not create, never `ready`", async () => {
    // The host holds setup status in memory, so a pre-existing worktree has no
    // record. Reporting `ready` there would be an interpretation of silence.
    const rows: Row[] = [{ id: "wt-1", path: "/a", branch: "main" }];
    setRows(rows);
    const def = action("worktree.list", callbacks(rows));
    const result = (await def.run!(undefined, {} as ActionContext)) as {
      worktrees: Array<{ setupState: string }>;
    };
    expect(result.worktrees[0]?.setupState).toBe("unknown");
  });

  it("surfaces a recorded state on the listing", async () => {
    const rows: Row[] = [
      {
        id: "wt-1",
        path: "/a",
        branch: "main",
        setupStatus: { state: "running", startedAt: 1 },
      },
    ];
    setRows(rows);
    const def = action("worktree.list", callbacks(rows));
    const result = (await def.run!(undefined, {} as ActionContext)) as {
      worktrees: Array<{ setupState: string }>;
    };
    expect(result.worktrees[0]?.setupState).toBe("running");
  });
});
