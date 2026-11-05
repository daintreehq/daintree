// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";
import type { WorktreeChanges } from "@shared/types/git";
import type { QuickCreateItem } from "../useQuickCreatePalette";

const mockRecipes = vi.hoisted(() => ({ value: [] as TerminalRecipe[] }));
const paletteCapture = vi.hoisted(() => ({
  items: [] as QuickCreateItem[],
  selectedIndex: 0,
}));
const dispatchMock = vi.hoisted(() => vi.fn());
const quickCreateContext = vi.hoisted(() => ({
  value: {
    issue: { number: 7, title: "Fix the thing" } as {
      number: number;
      title: string;
      branchName?: string;
    } | null,
    pr: null as { number: number; title: string } | null,
  },
}));
const openCreateDialogMock = vi.hoisted(() => vi.fn());
interface CapturedNotification {
  type?: string;
  title?: string;
  message?: unknown;
  context?: Record<string, unknown>;
  duration?: number;
  transient?: boolean;
  action?: { label: string; onClick: () => void; actionId?: string; actionArgs?: unknown };
}

const notifyMock = vi.hoisted(() => vi.fn((_payload: CapturedNotification) => "n-1"));
const getFreshChangesMock = vi.hoisted(() =>
  vi.fn<(worktreeId: string) => Promise<WorktreeChanges | null>>()
);

vi.mock("@/lib/notify", () => ({
  notify: (payload: CapturedNotification) => notifyMock(payload),
}));

vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    worktreeClient: {
      ...actual.worktreeClient,
      getFreshChanges: (id: string) => getFreshChangesMock(id),
    },
  };
});

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      recipes: mockRecipes.value,
      // Mirrors the real store: a shadowed recipe resolves to the same-named winner.
      getRecipeById: (id: string) => {
        const found = mockRecipes.value.find((r) => r.id === id);
        if (found?.shadowedBy) {
          return mockRecipes.value.find((r) => r.name === found.name && !r.shadowedBy) ?? found;
        }
        return found;
      },
    }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        quickCreate: { isOpen: false, ...quickCreateContext.value },
        openCreateDialog: openCreateDialogMock,
        closeQuickCreate: vi.fn(),
      }),
    {
      getState: () => ({ setPendingWorktree: vi.fn(), selectWorktree: vi.fn() }),
    }
  ),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ currentProject: null }),
    { getState: () => ({ currentProject: { path: "/repo" } }) }
  ),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

vi.mock("../useSearchablePalette", () => ({
  useSearchablePalette: ({ items }: { items: QuickCreateItem[] }) => {
    paletteCapture.items = items;
    return {
      isOpen: true,
      query: "",
      results: items,
      totalResults: items.length,
      selectedIndex: paletteCapture.selectedIndex,
      matchesById: new Map(),
      isStale: false,
      open: vi.fn(),
      close: vi.fn(),
      setQuery: vi.fn(),
      selectPrevious: vi.fn(),
      selectNext: vi.fn(),
    };
  },
}));

const { useQuickCreatePalette } = await import("../useQuickCreatePalette");

function makeRecipe(overrides: Partial<TerminalRecipe>): TerminalRecipe {
  return {
    id: "r",
    name: "Work",
    terminals: [{ type: "terminal", env: {} }],
    createdAt: 0,
    ...overrides,
  } as TerminalRecipe;
}

function listedIds(): string[] {
  return paletteCapture.items.map((i) => i.id);
}

function listedRow(id: string): QuickCreateItem {
  const row = paletteCapture.items.find((i) => i.id === id);
  if (!row) throw new Error(`No palette row ${id}`);
  return row;
}

beforeEach(() => {
  dispatchMock.mockReset();
  openCreateDialogMock.mockReset();
  notifyMock.mockClear();
  getFreshChangesMock.mockReset();
  quickCreateContext.value = { issue: { number: 7, title: "Fix the thing" }, pr: null };
  dispatchMock.mockResolvedValue({ ok: false, error: new Error("stop here") });
  paletteCapture.items = [];
  paletteCapture.selectedIndex = 0;
});

describe("useQuickCreatePalette — shadowed recipes (#11510)", () => {
  it("lists a shadowed recipe instead of dropping it from the palette", () => {
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo" }),
      makeRecipe({ id: "loser", projectId: "p", shadowedBy: "Work" }),
    ];

    renderHook(() => useQuickCreatePalette());

    expect(listedIds()).toContain("loser");
    expect(listedIds()).toContain("winner");
  });

  it("derives the auto-assign prompt from the winner, not the shadowed row", () => {
    // The loser opts out of assignment; the winner asks. Since selecting the
    // loser runs the winner, the toggle must follow the winner or the user is
    // never offered the choice that submission will act on.
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo", autoAssign: "prompt" }),
      makeRecipe({ id: "loser", projectId: "p", shadowedBy: "Work", autoAssign: "never" }),
    ];
    paletteCapture.selectedIndex = 1;

    const { result } = renderHook(() => useQuickCreatePalette());

    expect(result.current.selectedRecipe?.id).toBe("winner");
    expect(result.current.selectedRecipe?.autoAssign).toBe("prompt");
  });

  it("dispatches the selected row's own id and lets the store resolve the winner", async () => {
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo" }),
      makeRecipe({ id: "loser", projectId: "p", shadowedBy: "Work" }),
    ];

    const { result } = renderHook(() => useQuickCreatePalette());

    await act(async () => {
      result.current.confirmItem(listedRow("loser"));
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.createWithRecipe",
      expect.objectContaining({ recipeId: "loser" }),
      expect.anything()
    );
  });
});

describe("useQuickCreatePalette — worktree-scoped recipes (#14994)", () => {
  const recipes = () => [
    makeRecipe({ id: "project", name: "Project", projectId: "p" }),
    makeRecipe({ id: "pinned", name: "Pinned", projectId: "p", worktreeId: "wt-1" }),
  ];

  function expectDispatchedSource(source: Record<string, unknown>): void {
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.createWithRecipe",
      expect.objectContaining({ source: expect.objectContaining(source) }),
      expect.anything()
    );
  }

  it("leaves worktree recipes out when a pick opens the New Worktree dialog", () => {
    // The plain action carries no issue or PR, so every pick hands off to the
    // dialog, whose picker can't select a worktree recipe.
    quickCreateContext.value = { issue: null, pr: null };
    mockRecipes.value = recipes();

    renderHook(() => useQuickCreatePalette());

    expect(listedIds()).toEqual(["project", "__customize__"]);
  });

  it("hands the dialog the recipe under the cursor when confirmed from the keyboard", () => {
    quickCreateContext.value = { issue: null, pr: null };
    mockRecipes.value = recipes();

    const { result } = renderHook(() => useQuickCreatePalette());

    act(() => {
      result.current.confirmSelection();
    });

    expect(openCreateDialogMock).toHaveBeenCalledWith(null, { initialRecipeId: "project" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("leaves worktree recipes out and passes the issue on when its title can't name a branch", () => {
    // A title that slugs to nothing also falls through to the dialog.
    const issue = { number: 7, title: "!!!" };
    quickCreateContext.value = { issue, pr: null };
    mockRecipes.value = recipes();

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual(["project", "__customize__"]);

    act(() => {
      result.current.confirmItem(listedRow("project"));
    });

    expect(openCreateDialogMock).toHaveBeenCalledWith(issue, { initialRecipeId: "project" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("keeps worktree recipes when an issue names the branch and the recipe runs directly", async () => {
    mockRecipes.value = recipes();

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual(["project", "pinned", "__customize__"]);

    await act(async () => {
      result.current.confirmItem(listedRow("pinned"));
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.createWithRecipe",
      expect.objectContaining({ recipeId: "pinned" }),
      expect.anything()
    );
    expectDispatchedSource({
      kind: "newBranch",
      branchName: "bugfix/issue-7-fix-thing",
      issueNumber: 7,
    });
  });

  it("keeps worktree recipes for a PR, whose title names the branch", async () => {
    quickCreateContext.value = { issue: null, pr: { number: 12, title: "Tidy the sidebar" } };
    mockRecipes.value = recipes();

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual(["project", "pinned", "__customize__"]);

    await act(async () => {
      result.current.confirmItem(listedRow("pinned"));
    });

    expectDispatchedSource({ branchName: "feature/tidy-sidebar" });
    expect(openCreateDialogMock).not.toHaveBeenCalled();
  });

  it("keeps worktree recipes when a provider-suggested branch stands in for an unusable title", async () => {
    quickCreateContext.value = {
      issue: { number: 7, title: "!!!", branchName: "eng-7-fix" },
      pr: null,
    };
    mockRecipes.value = recipes();

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual(["project", "pinned", "__customize__"]);

    await act(async () => {
      result.current.confirmItem(listedRow("pinned"));
    });

    expectDispatchedSource({ branchName: "eng-7-fix" });
  });

  it("prefers the provider-suggested branch over one built from a usable title", async () => {
    quickCreateContext.value = {
      issue: { number: 7, title: "Fix the thing", branchName: "eng-7-fix" },
      pr: null,
    };
    mockRecipes.value = recipes();

    const { result } = renderHook(() => useQuickCreatePalette());

    await act(async () => {
      result.current.confirmItem(listedRow("project"));
    });

    expectDispatchedSource({ branchName: "eng-7-fix" });
  });

  it("still offers Customize… when every recipe is a worktree recipe and the pick opens the dialog", () => {
    quickCreateContext.value = { issue: null, pr: null };
    mockRecipes.value = [makeRecipe({ id: "pinned", projectId: "p", worktreeId: "wt-1" })];

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual(["__customize__"]);

    act(() => {
      result.current.confirmSelection();
    });

    expect(openCreateDialogMock).toHaveBeenCalledWith(null);
  });

  it("offers no rows and opens the recipe manager when there are no recipes at all", () => {
    quickCreateContext.value = { issue: null, pr: null };
    mockRecipes.value = [];

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual([]);

    act(() => {
      result.current.confirmSelection();
    });

    expect(dispatchMock).toHaveBeenCalledWith("recipe.manager.open", undefined, {
      source: "user",
    });
    expect(openCreateDialogMock).not.toHaveBeenCalled();
  });

  it("judges a shadowed row by its own scope, not its winner's, on the dialog path", () => {
    // The dialog lists rows by their own id, so a shadowed worktree row would
    // still be swapped out even though its winner is project-wide, while a
    // shadowed project row is listed there and hands its own id over.
    quickCreateContext.value = { issue: null, pr: null };
    mockRecipes.value = [
      makeRecipe({ id: "winner", scope: "inrepo" }),
      makeRecipe({ id: "project-loser", projectId: "p", shadowedBy: "Work" }),
      makeRecipe({ id: "pinned-loser", projectId: "p", worktreeId: "wt-1", shadowedBy: "Work" }),
    ];

    const { result } = renderHook(() => useQuickCreatePalette());
    expect(listedIds()).toEqual(["winner", "project-loser", "__customize__"]);

    act(() => {
      result.current.confirmItem(listedRow("project-loser"));
    });

    expect(openCreateDialogMock).toHaveBeenCalledWith(null, { initialRecipeId: "project-loser" });
  });
});

describe("useQuickCreatePalette — quick-create Undo (#16264)", () => {
  const created = {
    worktreeId: "wt-new",
    worktreePath: "/repo/.worktrees/fix",
    branch: "bugfix/issue-7-fix-thing",
    recipeLaunched: true,
    assignedToSelf: true,
    assignedUsername: "octo",
    assignmentError: null,
  };

  const clean = {
    worktreeId: "wt-new",
    rootPath: "/repo/.worktrees/fix",
    changes: [],
    changedFileCount: 0,
  } satisfies WorktreeChanges;

  type CreatedNotification = CapturedNotification & {
    action: NonNullable<CapturedNotification["action"]>;
  };

  function routeDispatch(deleteResult: { ok: boolean; error?: unknown } = { ok: true }): void {
    dispatchMock.mockImplementation(async (actionId: string) => {
      if (actionId === "worktree.createWithRecipe") return { ok: true, result: created };
      if (actionId === "worktree.delete") return deleteResult;
      if (actionId === "forge.unassignIssue") return { ok: true, result: undefined };
      return { ok: false, error: { code: "NOT_FOUND", message: actionId } };
    });
  }

  async function createAndGetNotification(): Promise<CreatedNotification> {
    mockRecipes.value = [makeRecipe({ id: "project", name: "Project", projectId: "p" })];
    const { result } = renderHook(() => useQuickCreatePalette());
    await act(async () => {
      result.current.confirmItem(listedRow("project"));
    });
    const payload = notifyMock.mock.calls.find(([p]) => p.title === "Worktree created")?.[0];
    if (!payload?.action) throw new Error("No success notification with an action");
    notifyMock.mockClear();
    return { ...payload, action: payload.action };
  }

  async function clickUndo(onClick: () => void): Promise<void> {
    await act(async () => {
      onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function dispatchedIds(): string[] {
    return dispatchMock.mock.calls.map(([id]) => String(id));
  }

  function onlyWarningMessage(): string {
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const warning = notifyMock.mock.calls[0]![0];
    expect(warning).toMatchObject({ type: "warning", context: { worktreeId: "wt-new" } });
    return String(warning.message);
  }

  function expectKeptAndStillAssigned(): void {
    expect(dispatchedIds()).not.toContain("worktree.delete");
    expect(dispatchedIds()).not.toContain("forge.unassignIssue");
  }

  it.each([
    [
      "a modified tracked file",
      {
        ...clean,
        changes: [{ path: "src/a.ts", status: "modified", insertions: 2, deletions: 1 }],
        changedFileCount: 1,
      } satisfies WorktreeChanges,
    ],
    // Untracked files past the listing cap are counted but not listed.
    [
      "untracked files left out of the listing",
      { ...clean, changedFileCount: 3, omittedUntrackedCount: 3 } satisfies WorktreeChanges,
    ],
  ])(
    "keeps a worktree that gained %s after it was created, and its assignment",
    async (_label, changes) => {
      routeDispatch();
      getFreshChangesMock.mockResolvedValue(clean);
      const notification = await createAndGetNotification();
      // Clean when the toast went up; the agent writes before the click.
      expect(getFreshChangesMock).not.toHaveBeenCalled();
      getFreshChangesMock.mockResolvedValue(changes);

      await clickUndo(notification.action.onClick);

      expect(getFreshChangesMock).toHaveBeenCalledWith("wt-new");
      expectKeptAndStillAssigned();
      const message = onlyWarningMessage();
      expect(message).toContain(created.branch);
      expect(message).toMatch(/untracked/);
      expect(message).toMatch(/Delete worktree/);
    }
  );

  it.each([
    [
      "the status read fails",
      () => getFreshChangesMock.mockRejectedValue(new Error("port closed")),
    ],
    ["the worktree has no monitor", () => getFreshChangesMock.mockResolvedValue(null)],
  ])("keeps the worktree when %s, since its changes can't be checked", async (_label, arrange) => {
    routeDispatch();
    arrange();
    const notification = await createAndGetNotification();

    await clickUndo(notification.action.onClick);

    expectKeptAndStillAssigned();
    const message = onlyWarningMessage();
    expect(message).toMatch(/couldn't check/i);
    expect(message).toMatch(/Delete worktree/);
  });

  it("asks for a plain delete, and keeps the assignment when the host refuses it", async () => {
    // Something can land between the status read and the delete; the plain
    // delete is what lets the host refuse it then.
    const refusal = "Worktree has untracked files. Use force delete to proceed.";
    routeDispatch({ ok: false, error: { code: "EXECUTION_ERROR", message: refusal } });
    getFreshChangesMock.mockResolvedValue(clean);
    const notification = await createAndGetNotification();

    await clickUndo(notification.action.onClick);

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-new" },
      { source: "user" }
    );
    expect(dispatchedIds()).not.toContain("forge.unassignIssue");
    expect(onlyWarningMessage()).toContain(refusal);
  });

  it("deletes an untouched worktree and takes the assignment back", async () => {
    routeDispatch();
    getFreshChangesMock.mockResolvedValue(clean);
    const notification = await createAndGetNotification();

    await clickUndo(notification.action.onClick);

    expect(dispatchedIds().slice(-2)).toEqual(["worktree.delete", "forge.unassignIssue"]);
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "forge.unassignIssue",
      { cwd: "/repo", issueNumber: 7, username: "octo" },
      { source: "user" }
    );
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("acts once however many times Undo is clicked, during or after the first", async () => {
    routeDispatch();
    getFreshChangesMock.mockResolvedValue(clean);
    const notification = await createAndGetNotification();

    notification.action.onClick();
    await clickUndo(notification.action.onClick);
    await clickUndo(notification.action.onClick);

    expect(getFreshChangesMock).toHaveBeenCalledTimes(1);
    expect(dispatchedIds().filter((id) => id === "worktree.delete")).toHaveLength(1);
    expect(dispatchedIds().filter((id) => id === "forge.unassignIssue")).toHaveLength(1);
  });

  it("stays spent after a refusal, so a second click can't try again", async () => {
    routeDispatch();
    getFreshChangesMock.mockResolvedValue({
      ...clean,
      changedFileCount: 1,
      omittedUntrackedCount: 1,
    });
    const notification = await createAndGetNotification();

    await clickUndo(notification.action.onClick);
    getFreshChangesMock.mockResolvedValue(clean);
    await clickUndo(notification.action.onClick);

    expect(getFreshChangesMock).toHaveBeenCalledTimes(1);
    expectKeptAndStillAssigned();
  });

  it("leaves the inbox entry no Undo to replay later, and lets the toast expire", async () => {
    routeDispatch();
    const notification = await createAndGetNotification();

    // The inbox row can only replay a stored actionId, at any later time and
    // without the change check or the un-assign.
    expect(notification.action.actionId).toBeUndefined();
    expect(notification.action.actionArgs).toBeUndefined();
    expect(notification.transient).not.toBe(true);
    expect(notification.duration).toBeGreaterThan(0);
  });
});
