// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { WorktreeState } from "@/types";
import { MAIN_WORKTREE_NOTE_TTL_MS } from "@/lib/worktreeAiNote";

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

function getAction() {
  const actions: ActionRegistry = new Map();
  const callbacks = { onInject: vi.fn() } as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get("worktree.openReviewHub");
  if (!factory) throw new Error("worktree.openReviewHub is not registered");
  return factory();
}

function seedWorktree(id: string, overrides: Partial<WorktreeState> = {}) {
  worktreesMock.current.set(id, { id, path: `/repo/${id}`, ...overrides });
}

/** The options the action passed to `openPanelDialog` on its only call. */
function dialogOptions() {
  expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
  return openPanelDialogMock.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreesMock.current = new Map();
  openPanelDialogMock.mockResolvedValue("review-1");
});

describe("worktree.openReviewHub", () => {
  it("registers a renderer-scoped command action", () => {
    const action = getAction();
    expect(action.id).toBe("worktree.openReviewHub");
    expect(action.kind).toBe("command");
    expect(action.danger).toBe("safe");
    expect(action.scope).toBe("renderer");
  });

  it("accepts an optional worktreeId argument", () => {
    const action = getAction();
    expect(action.argsSchema).toBeDefined();
    expect(() => action.argsSchema!.parse({ worktreeId: "wt-1" })).not.toThrow();
    expect(() => action.argsSchema!.parse({})).not.toThrow();
    expect(() => action.argsSchema!.parse(undefined)).not.toThrow();
  });

  it("presents the review panel as a dialog for an explicit worktreeId", async () => {
    seedWorktree("wt-1");
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(dialogOptions()).toMatchObject({
      kind: "review",
      worktreeId: "wt-1",
      autoStageOnOpen: true,
    });
  });

  it("falls back to focusedWorktreeId then activeWorktreeId", async () => {
    seedWorktree("wt-focus");
    seedWorktree("wt-active");
    await getAction().run(undefined, {
      focusedWorktreeId: "wt-focus",
      activeWorktreeId: "wt-active",
    } as ActionContext);

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-focus" });
  });

  it("falls back to activeWorktreeId when no focused worktree is set", async () => {
    seedWorktree("wt-active");
    await getAction().run(undefined, { activeWorktreeId: "wt-active" } as ActionContext);

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-active" });
  });

  it("no-ops when no worktreeId can be resolved", async () => {
    await getAction().run(undefined, {} as ActionContext);
    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  it("no-ops when the resolved worktree has no record", async () => {
    await getAction().run({ worktreeId: "ghost" }, {} as ActionContext);
    expect(openPanelDialogMock).not.toHaveBeenCalled();
  });

  describe("commit-message seed (#7884)", () => {
    it("seeds the first line of a current AI note", async () => {
      seedWorktree("wt-1", { aiNote: "Fix the parser crash\n\nLonger body text" });
      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(dialogOptions()).toMatchObject({ initialCommitMessage: "Fix the parser crash" });
    });

    it("seeds empty when the worktree has no AI note", async () => {
      seedWorktree("wt-1");
      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(dialogOptions()).toMatchObject({ initialCommitMessage: "" });
    });

    it("seeds empty when a whitespace-only note would otherwise look present", async () => {
      seedWorktree("wt-1", { aiNote: "   \n  " });
      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(dialogOptions()).toMatchObject({ initialCommitMessage: "" });
    });

    it("seeds empty for an expired main-worktree note", async () => {
      seedWorktree("wt-main", {
        aiNote: "Stale note from an hour ago",
        aiNoteTimestamp: Date.now() - (MAIN_WORKTREE_NOTE_TTL_MS + 60_000),
        isMainWorktree: true,
      });
      await getAction().run({ worktreeId: "wt-main" }, {} as ActionContext);

      expect(dialogOptions()).toMatchObject({ initialCommitMessage: "" });
    });

    it("never substitutes another field when the note is absent", async () => {
      // A worktree rich in plausible-looking alternatives: branch name, last
      // commit subject, an issue title. Substituting any of them for an absent
      // note is what caused a bad push to a shared branch (#7884).
      seedWorktree("wt-1", {
        branch: "feature/parser-fix",
        issueTitle: "Parser crashes on empty input",
        lastCommitMessage: "chore: bump deps",
      } as Partial<WorktreeState>);
      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(dialogOptions()).toMatchObject({ initialCommitMessage: "" });
    });
  });
});
