// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const worktreesMock = vi.hoisted(() => ({ current: new Map<string, Partial<WorktreeState>>() }));

const systemClientMock = vi.hoisted(() => ({
  openInEditor: vi.fn<(p: Record<string, unknown>) => Promise<void>>(() => Promise.resolve()),
  openPath: vi.fn<(p: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
  getCurrentViewStoreOrNull: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
}));

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: systemClientMock,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import { registerWorktreeContextActions } from "../worktreeContextActions";

function getAction(id: "worktree.openEditor" | "worktree.reveal") {
  const actions: ActionRegistry = new Map();
  // `ActionCallbacks` has ~30 members and neither action here reaches one —
  // both go straight to `systemClient`. Same stub the sibling suites use.
  const callbacks = {} as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`${id} is not registered`);
  return factory();
}

function seedWorktree(id: string, path = `/repo/${id}`) {
  worktreesMock.current.set(id, { id, path });
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreesMock.current = new Map();
  systemClientMock.openInEditor.mockResolvedValue(undefined);
  systemClientMock.openPath.mockResolvedValue(undefined);
});

describe("worktree.openEditor", () => {
  it("registers a renderer-scoped command action", () => {
    const action = getAction("worktree.openEditor");
    expect(action.id).toBe("worktree.openEditor");
    expect(action.kind).toBe("command");
    expect(action.danger).toBe("safe");
    expect(action.scope).toBe("renderer");
  });

  it("accepts an optional worktreeId argument", () => {
    const action = getAction("worktree.openEditor");
    expect(action.argsSchema).toBeDefined();
    expect(() => action.argsSchema!.parse({ worktreeId: "wt-1" })).not.toThrow();
    expect(() => action.argsSchema!.parse({})).not.toThrow();
    expect(() => action.argsSchema!.parse(undefined)).not.toThrow();
  });

  // The bug (#12329): this used to call `openPath`, the OS default handler,
  // which is what "Reveal Worktree" does — two menu items, one behaviour.
  it("opens the worktree through the editor pipeline, never the OS handler", async () => {
    seedWorktree("wt-1", "/repo/wt-1");

    await getAction("worktree.openEditor").run({ worktreeId: "wt-1" }, {
      projectId: "proj-1",
    } as ActionContext);

    expect(systemClientMock.openInEditor).toHaveBeenCalledWith({
      path: "/repo/wt-1",
      projectId: "proj-1",
    });
    expect(systemClientMock.openPath).not.toHaveBeenCalled();
  });

  // Omitting the project id is what made external editor launches ignore the
  // preference in #12327 — the main process then has nothing to look up.
  it("carries the context project id so the right editor preference is read", async () => {
    seedWorktree("wt-1");

    await getAction("worktree.openEditor").run({ worktreeId: "wt-1" }, {
      projectId: "proj-42",
    } as ActionContext);

    expect(systemClientMock.openInEditor.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-42",
    });
  });

  it("forwards an undefined project id rather than inventing one", async () => {
    seedWorktree("wt-1");

    await getAction("worktree.openEditor").run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(systemClientMock.openInEditor).toHaveBeenCalledWith({
      path: "/repo/wt-1",
      projectId: undefined,
    });
  });

  it("falls back to the focused worktree, then the active one", async () => {
    seedWorktree("wt-focused", "/repo/focused");
    seedWorktree("wt-active", "/repo/active");

    await getAction("worktree.openEditor").run(undefined, {
      focusedWorktreeId: "wt-focused",
      activeWorktreeId: "wt-active",
      projectId: "proj-1",
    } as ActionContext);

    expect(systemClientMock.openInEditor).toHaveBeenCalledWith({
      path: "/repo/focused",
      projectId: "proj-1",
    });

    systemClientMock.openInEditor.mockClear();

    await getAction("worktree.openEditor").run(undefined, {
      activeWorktreeId: "wt-active",
      projectId: "proj-1",
    } as ActionContext);

    expect(systemClientMock.openInEditor).toHaveBeenCalledWith({
      path: "/repo/active",
      projectId: "proj-1",
    });
  });

  it("no-ops when no worktree is selected", async () => {
    await getAction("worktree.openEditor").run(undefined, {} as ActionContext);

    expect(systemClientMock.openInEditor).not.toHaveBeenCalled();
  });

  it("no-ops when the selected worktree is gone", async () => {
    await getAction("worktree.openEditor").run({ worktreeId: "wt-missing" }, {} as ActionContext);

    expect(systemClientMock.openInEditor).not.toHaveBeenCalled();
  });

  it("propagates a launch failure to the caller", async () => {
    seedWorktree("wt-1");
    systemClientMock.openInEditor.mockRejectedValueOnce(new Error("outside root"));

    await expect(
      getAction("worktree.openEditor").run({ worktreeId: "wt-1" }, {} as ActionContext)
    ).rejects.toThrow("outside root");
  });
});

describe("worktree.reveal", () => {
  // The sibling action that legitimately wants the OS file manager. It shares
  // the menu with "Open in Editor" and must keep its own behaviour.
  it("still reveals through the OS handler", async () => {
    seedWorktree("wt-1", "/repo/wt-1");

    await getAction("worktree.reveal").run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(systemClientMock.openPath).toHaveBeenCalledWith("/repo/wt-1");
    expect(systemClientMock.openInEditor).not.toHaveBeenCalled();
  });
});
