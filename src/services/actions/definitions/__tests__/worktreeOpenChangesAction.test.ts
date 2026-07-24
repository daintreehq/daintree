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
  worktreesMock.current.set(id, {
    id,
    path: rootPath,
    worktreeChanges: {
      rootPath,
      changes,
      changedFileCount: changes.length,
    },
  } as Partial<WorktreeState>);
}

/** Seed a worktree whose poll has not reported yet. */
function seedUnpolledWorktree(id: string) {
  worktreesMock.current.set(id, { id, path: ROOT, worktreeChanges: null });
}

function dialogOptions() {
  expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
  return openPanelDialogMock.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreesMock.current = new Map();
  openPanelDialogMock.mockResolvedValue("diff-1");
});

describe("worktree.openChanges — registration", () => {
  it("registers a safe renderer command", () => {
    const action = getAction();
    expect(action.kind).toBe("command");
    expect(action.danger).toBe("safe");
    expect(action.scope).toBe("renderer");
  });

  it("accepts an optional worktreeId and rejects a non-string one", () => {
    const action = getAction();
    expect(action.argsSchema).toBeDefined();
    expect(() => action.argsSchema!.parse({ worktreeId: "wt-1" })).not.toThrow();
    expect(() => action.argsSchema!.parse({})).not.toThrow();
    expect(() => action.argsSchema!.parse(undefined)).not.toThrow();
    expect(() => action.argsSchema!.parse({ worktreeId: 7 })).toThrow();
  });

  it("pairs isEnabled with a disabledReason so a disabled row can explain itself", () => {
    const action = getAction();
    expect(action.isEnabled).toBeDefined();
    expect(action.disabledReason).toBeDefined();
  });
});

describe("worktree.openChanges — enablement", () => {
  it("is enabled when the focused worktree has changes", () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    expect(getAction().isEnabled!({ focusedWorktreeId: "wt-1" })).toBe(true);
  });

  it("is disabled when the focused worktree reported no changes", () => {
    seedWorktree("wt-1", []);
    const action = getAction();
    expect(action.isEnabled!({ focusedWorktreeId: "wt-1" })).toBe(false);
    expect(action.disabledReason!({ focusedWorktreeId: "wt-1" })).toBeTruthy();
  });

  it("is disabled while the worktree poll has not reported yet", () => {
    seedUnpolledWorktree("wt-unpolled");
    seedWorktree("wt-clean", []);
    const action = getAction();

    expect(action.isEnabled!({ focusedWorktreeId: "wt-unpolled" })).toBe(false);
    // A not-yet-polled worktree explains itself differently from a clean one:
    // one resolves on its own, the other needs the user to make an edit.
    expect(action.disabledReason!({ focusedWorktreeId: "wt-unpolled" })).not.toBe(
      action.disabledReason!({ focusedWorktreeId: "wt-clean" })
    );
  });

  it("is disabled when no worktree is focused or active", () => {
    const action = getAction();
    expect(action.isEnabled!({})).toBe(false);
    expect(action.disabledReason!({})).toBeTruthy();
  });

  it("is disabled when the focused id resolves to no worktree", () => {
    const action = getAction();
    expect(action.isEnabled!({ focusedWorktreeId: "gone" })).toBe(false);
    expect(action.disabledReason!({ focusedWorktreeId: "gone" })).toBeTruthy();
  });

  it("falls back to the active worktree when none is focused", () => {
    seedWorktree("wt-active", [change("a.ts", "modified", 1, 0)]);
    expect(getAction().isEnabled!({ activeWorktreeId: "wt-active" })).toBe(true);
  });

  it("prefers the focused worktree over the active one", () => {
    seedWorktree("wt-focus", []);
    seedWorktree("wt-active", [change("a.ts", "modified", 1, 0)]);

    expect(
      getAction().isEnabled!({ focusedWorktreeId: "wt-focus", activeWorktreeId: "wt-active" })
    ).toBe(false);
  });

  it("gives no disabledReason when the action is enabled", () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    expect(getAction().disabledReason!({ focusedWorktreeId: "wt-1" })).toBeUndefined();
  });
});

describe("worktree.openChanges — opening the diff", () => {
  it("opens the working-tree diff for an explicit worktreeId", async () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

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
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(dialogOptions()).toMatchObject({ filePath: "biggest.ts", fileStatus: "modified" });
  });

  it("hands over the whole change set, not just the opened file", async () => {
    seedWorktree("wt-1", [
      change("a.ts", "modified", 1, 0),
      change("b.ts", "added", 2, 0),
      change("c.ts", "deleted", 3, 0),
    ]);
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    const options = dialogOptions();
    expect(options.changeSet).toHaveLength(3);
    // The opened file must be the set's first entry, or the sidebar opens
    // highlighting a different row than the pane is showing.
    expect(options.changeSet![0]!.path).toBe(options.filePath);
  });

  it("addresses the opened file by a root-relative path", async () => {
    seedWorktree("wt-1", [change(`${ROOT}/src/deep/file.ts`, "modified", 1, 0)]);
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(dialogOptions()).toMatchObject({ filePath: "src/deep/file.ts", title: "file.ts" });
  });

  it("uses the change set's own viewed key for the opened file", async () => {
    seedWorktree("wt-1", [change("a.ts", "modified", 1, 0)]);
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    const options = dialogOptions();
    expect(options.viewedKey).toBe(options.changeSet![0]!.viewedKey);
  });

  it("resolves the target from focus when args omit it", async () => {
    seedWorktree("wt-focus", [change("focused.ts", "modified", 1, 0)]);
    await getAction().run({}, { focusedWorktreeId: "wt-focus" } as ActionContext);

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-focus", filePath: "focused.ts" });
  });

  it("falls back to the active worktree when nothing is focused", async () => {
    seedWorktree("wt-active", [change("active.ts", "modified", 1, 0)]);
    await getAction().run({}, { activeWorktreeId: "wt-active" } as ActionContext);

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-active" });
  });

  it("lets an explicit worktreeId win over the focused worktree", async () => {
    seedWorktree("wt-focus", [change("focused.ts", "modified", 1, 0)]);
    seedWorktree("wt-explicit", [change("explicit.ts", "modified", 1, 0)], "/repo/wt-explicit");

    await getAction().run(
      { worktreeId: "wt-explicit" },
      { focusedWorktreeId: "wt-focus" } as ActionContext
    );

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-explicit" });
  });

  it("reads the change set at dispatch time rather than from a cached snapshot", async () => {
    seedWorktree("wt-1", [change("first.ts", "modified", 1, 0)]);
    const action = getAction();

    seedWorktree("wt-1", [change("second.ts", "modified", 5, 0)]);
    await action.run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(dialogOptions()).toMatchObject({ filePath: "second.ts" });
  });
});

describe("worktree.openChanges — nothing to open", () => {
  it("opens nothing when the worktree has no changes", async () => {
    seedWorktree("wt-1", []);
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("opens nothing when the poll has not reported yet", async () => {
    seedUnpolledWorktree("wt-1");
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("opens nothing when the worktree is gone", async () => {
    await getAction().run({ worktreeId: "missing" }, {} as ActionContext);

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("opens nothing when no target can be resolved at all", async () => {
    await getAction().run({}, {} as ActionContext);

    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });
});
