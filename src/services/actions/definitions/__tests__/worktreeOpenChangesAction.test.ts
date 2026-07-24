// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { FileChangeDetail, GitStatus } from "@shared/types/git";
import type { WorktreeState } from "@/types";

const openPanelDialogMock = vi.hoisted(() =>
  vi.fn<(o: AddPanelOptions) => Promise<string | null>>()
);
const worktreesMock = vi.hoisted(() => ({ current: new Map<string, Partial<WorktreeState>>() }));

vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: { getState: () => ({ openPanelDialog: openPanelDialogMock }) },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
}));

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import { registerWorktreeContextActions } from "../worktreeContextActions";

const ROOT = "/repo/wt-1";

function getAction() {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- registerWorktreeContextActions takes the whole callback surface; openChanges touches none of it. Same shape the sibling openReviewHub test uses.
  const callbacks = { onInject: vi.fn() } as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get("worktree.openChanges");
  if (!factory) throw new Error("worktree.openChanges is not registered");
  return factory();
}

function change(
  path: string,
  status: GitStatus,
  insertions: number | null = 0,
  deletions: number | null = 0
): FileChangeDetail {
  return { path, status, insertions, deletions };
}

/** Seed a worktree whose poll has reported the given changes. */
function seedWorktree(id: string, changes: FileChangeDetail[], rootPath = ROOT) {
  const seeded: Partial<WorktreeState> = {
    id,
    path: rootPath,
    worktreeChanges: {
      worktreeId: id,
      rootPath,
      changes,
      changedFileCount: changes.length,
    },
  };
  worktreesMock.current.set(id, seeded);
}

/** Seed a worktree whose poll has not reported yet. */
function seedUnpolledWorktree(id: string) {
  worktreesMock.current.set(id, { id, path: ROOT, worktreeChanges: null });
}

function dialogOptions() {
  expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
  return openPanelDialogMock.mock.calls[0]![0];
}

/** The same options narrowed to the diff panel, which owns `changeSet`. */
function diffDialogOptions() {
  const options = dialogOptions();
  if (options.kind !== "diff") throw new Error(`expected a diff panel, got "${options.kind}"`);
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreesMock.current = new Map();
  openPanelDialogMock.mockResolvedValue("diff-1");
});

describe("worktree.openChanges — registration", () => {
  it("accepts an optional worktreeId and rejects a non-string one", () => {
    const action = getAction();
    expect(() => action.argsSchema!.parse({ worktreeId: "wt-1" })).not.toThrow();
    expect(() => action.argsSchema!.parse({})).not.toThrow();
    expect(() => action.argsSchema!.parse(undefined)).not.toThrow();
    expect(() => action.argsSchema!.parse({ worktreeId: 7 })).toThrow();
  });

  it("never gates dispatch, so an explicit target is honoured whatever holds focus", () => {
    // The gate lives on the palette row only. isEnabled would answer for the
    // focused worktree even when args name a different one — refusing a dirty
    // target, or passing a clean one and reporting ok for a run() that opened
    // nothing.
    const action = getAction();
    expect(action.isEnabled).toBeUndefined();
  });
});

describe("worktree.openChanges — palette readiness", () => {
  function isReady(ctx: ActionContext): boolean {
    const palette = getAction().palette;
    if (palette?.mode !== "requireContext") throw new Error("expected a requireContext palette");
    return palette.isReady(ctx);
  }

  it("offers a reason for the disabled row", () => {
    const palette = getAction().palette;
    expect(palette?.mode).toBe("requireContext");
    if (palette?.mode !== "requireContext") throw new Error("expected a requireContext palette");
    expect(palette.reason.length).toBeGreaterThan(0);
  });

  it("is ready when the focused worktree has changes", () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    expect(isReady({ focusedWorktreeId: "wt-1" })).toBe(true);
  });

  it("is not ready when the focused worktree reported no changes", () => {
    seedWorktree("wt-1", []);
    expect(isReady({ focusedWorktreeId: "wt-1" })).toBe(false);
  });

  it("is not ready while the worktree poll has not reported yet", () => {
    seedUnpolledWorktree("wt-1");
    expect(isReady({ focusedWorktreeId: "wt-1" })).toBe(false);
  });

  it("is not ready when no worktree is focused or active", () => {
    expect(isReady({})).toBe(false);
  });

  it("is not ready when the focused id resolves to no worktree", () => {
    expect(isReady({ focusedWorktreeId: "gone" })).toBe(false);
  });

  it("falls back to the active worktree when none is focused", () => {
    seedWorktree("wt-active", [change("a.ts", "modified", 1, 0)]);
    expect(isReady({ activeWorktreeId: "wt-active" })).toBe(true);
  });

  it("prefers the focused worktree over the active one", () => {
    seedWorktree("wt-focus", []);
    seedWorktree("wt-active", [change("a.ts", "modified", 1, 0)]);

    expect(isReady({ focusedWorktreeId: "wt-focus", activeWorktreeId: "wt-active" })).toBe(false);
  });

  it("tracks the live store rather than readiness at registration time", () => {
    seedWorktree("wt-1", []);
    const action = getAction();
    const palette = action.palette;
    if (palette?.mode !== "requireContext") throw new Error("expected a requireContext palette");
    expect(palette.isReady({ focusedWorktreeId: "wt-1" })).toBe(false);

    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    expect(palette.isReady({ focusedWorktreeId: "wt-1" })).toBe(true);
  });
});

describe("worktree.openChanges — explicit target beats context", () => {
  it("opens a dirty target named in args while a clean worktree holds focus", async () => {
    seedWorktree("wt-clean", []);
    seedWorktree("wt-dirty", [change("dirty.ts", "modified", 1, 0)], "/repo/wt-dirty");

    await getAction().run({ worktreeId: "wt-dirty" }, { focusedWorktreeId: "wt-clean" });

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-dirty", filePath: "dirty.ts" });
  });

  it("opens nothing for a clean target named in args while a dirty worktree holds focus", async () => {
    seedWorktree("wt-clean", []);
    seedWorktree("wt-dirty", [change("dirty.ts", "modified", 1, 0)], "/repo/wt-dirty");

    await getAction().run({ worktreeId: "wt-clean" }, { focusedWorktreeId: "wt-dirty" });

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });
});

describe("worktree.openChanges — opening the diff", () => {
  it("opens the working-tree diff for an explicit worktreeId", async () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    await getAction().run({ worktreeId: "wt-1" }, {});

    expect(dialogOptions()).toMatchObject({
      kind: "diff",
      diffSource: "working-tree",
      worktreeId: "wt-1",
    });
  });

  it("opens the highest-churn file first", async () => {
    seedWorktree("wt-1", [
      change("small.ts", "modified", 1, 0),
      change("biggest.ts", "modified", 20, 20),
      change("medium.ts", "modified", 9, 0),
    ]);
    await getAction().run({ worktreeId: "wt-1" }, {});

    expect(dialogOptions()).toMatchObject({ filePath: "biggest.ts", fileStatus: "modified" });
  });

  it("hands over every seeded change, not just the opened file", async () => {
    const seeded = [
      change("a.ts", "modified", 1, 0),
      change("b.ts", "added", 2, 0),
      change("c.ts", "deleted", 3, 0),
    ];
    seedWorktree("wt-1", seeded);
    await getAction().run({ worktreeId: "wt-1" }, {});

    // Compare as multisets: order is the helper's business, membership is this
    // action's. A length check alone would pass on `[x, x, x]`.
    const delivered = diffDialogOptions().changeSet!.map((e) => `${e.status}:${e.path}`);
    expect([...delivered].sort()).toEqual(seeded.map((c) => `${c.status}:${c.path}`).sort());
  });

  it("opens the file that is the change set's first entry", async () => {
    // Otherwise the sidebar highlights a different row than the pane shows.
    seedWorktree("wt-1", [
      change("a.ts", "modified", 1, 0),
      change("b.ts", "added", 40, 0),
      change("c.ts", "deleted", 3, 0),
    ]);
    await getAction().run({ worktreeId: "wt-1" }, {});

    const options = diffDialogOptions();
    expect(options.filePath).toBe(options.changeSet![0]!.path);
    expect(options.fileStatus).toBe(options.changeSet![0]!.status);
  });

  it("addresses the opened file by a root-relative path", async () => {
    seedWorktree("wt-1", [change(`${ROOT}/src/deep/file.ts`, "modified", 1, 0)]);
    await getAction().run({ worktreeId: "wt-1" }, {});

    expect(dialogOptions()).toMatchObject({ filePath: "src/deep/file.ts", title: "file.ts" });
  });

  it("uses the change set's own viewed key for the opened file", async () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    await getAction().run({ worktreeId: "wt-1" }, {});

    const options = diffDialogOptions();
    expect(options.viewedKey).toBe(options.changeSet![0]!.viewedKey);
  });

  it("resolves the target from focus when args omit it", async () => {
    seedWorktree("wt-focus", [change("focused.ts", "modified", 1, 0)]);
    await getAction().run({}, { focusedWorktreeId: "wt-focus" });

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-focus", filePath: "focused.ts" });
  });

  it("falls back to the active worktree when nothing is focused", async () => {
    seedWorktree("wt-active", [change("active.ts", "modified", 1, 0)]);
    await getAction().run({}, { activeWorktreeId: "wt-active" });

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-active" });
  });

  it("lets an explicit worktreeId win over the focused worktree", async () => {
    seedWorktree("wt-focus", [change("focused.ts", "modified", 1, 0)]);
    seedWorktree("wt-explicit", [change("explicit.ts", "modified", 1, 0)], "/repo/wt-explicit");

    await getAction().run({ worktreeId: "wt-explicit" }, { focusedWorktreeId: "wt-focus" });

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-explicit" });
  });

  it("reads the change set at dispatch time rather than from a cached snapshot", async () => {
    seedWorktree("wt-1", [change("first.ts", "modified", 1, 0)]);
    const action = getAction();

    seedWorktree("wt-1", [change("second.ts", "modified", 5, 0)]);
    await action.run({ worktreeId: "wt-1" }, {});

    expect(dialogOptions()).toMatchObject({ filePath: "second.ts" });
  });
});

describe("worktree.openChanges — nothing to open", () => {
  it("opens nothing when the worktree has no changes", async () => {
    seedWorktree("wt-1", []);
    await getAction().run({ worktreeId: "wt-1" }, {});

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("opens nothing when the poll has not reported yet", async () => {
    seedUnpolledWorktree("wt-1");
    await getAction().run({ worktreeId: "wt-1" }, {});

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("opens nothing when the worktree is gone", async () => {
    await getAction().run({ worktreeId: "missing" }, {});

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("opens nothing when no target can be resolved at all", async () => {
    await getAction().run({}, {});

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });
});
