/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { BranchInfo } from "@/types/electron";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const mockDispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

const mockGetAvailableBranch = vi.fn();
const mockGetDefaultPath = vi.fn();
const mockListBranches = vi.fn();
const mockFetchPRBranch = vi.fn();
const mockGetRecentBranches = vi.fn();
const mockGetCurrentUser = vi.fn();
const mockAssignIssue = vi.fn();
const mockUnassignIssue = vi.fn();

const mockAgentSettingsGet = vi.fn().mockResolvedValue({ agents: {} });
vi.mock("@/clients", () => ({
  worktreeClient: {
    getAvailableBranch: (...args: unknown[]) => mockGetAvailableBranch(...args),
    getDefaultPath: (...args: unknown[]) => mockGetDefaultPath(...args),
    listBranches: (...args: unknown[]) => mockListBranches(...args),
    fetchPRBranch: (...args: unknown[]) => mockFetchPRBranch(...args),
    getRecentBranches: (...args: unknown[]) => mockGetRecentBranches(...args),
    hasResourceConfig: vi.fn().mockResolvedValue({ hasConfig: false }),
  },
  forgeClient: {
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
    assignIssue: (...args: unknown[]) => mockAssignIssue(...args),
    unassignIssue: (...args: unknown[]) => mockUnassignIssue(...args),
  },
  agentSettingsClient: {
    get: (...args: unknown[]) => mockAgentSettingsGet(...args),
  },
}));

vi.mock("@/clients/systemClient", () => ({
  systemClient: {
    openExternal: vi.fn(),
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
  },
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) =>
    id === "claude"
      ? { command: "claude", name: "Claude", tooltip: "", color: "#000", iconId: "agent" }
      : undefined,
  isRegisteredAgent: (id: string) => id === "claude",
}));

const mockAddTerminal = vi.fn().mockResolvedValue("new-terminal-id");
vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(() => ({}), {
    getState: () => ({ addPanel: mockAddTerminal }),
  }),
}));

const mockGenerateRecipeFromActiveTerminals = vi.fn().mockReturnValue([]);
const recipeFixtures = vi.hoisted(() => ({ recipes: [] as unknown[] }));
vi.mock("@/store/recipeStore", () => {
  const recipeState = {
    get recipes() {
      return recipeFixtures.recipes;
    },
    runRecipeWithResults: vi.fn(),
  };
  return {
    useRecipeStore: Object.assign(
      (selector?: (s: typeof recipeState) => unknown) =>
        selector ? selector(recipeState) : recipeState,
      {
        getState: () => ({
          runRecipeWithResults: vi.fn(),
          getRecipeById: () => null,
          generateRecipeFromActiveTerminals: mockGenerateRecipeFromActiveTerminals,
        }),
      }
    ),
  };
});

let mockAssignWorktreeToSelf = false;
vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      assignWorktreeToSelf: mockAssignWorktreeToSelf,
      setAssignWorktreeToSelf: vi.fn(),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: vi.fn(),
    }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProject: { id: "test-project", path: "/test/root" } }),
}));

const mockWorktreeDataMap = new Map();
mockWorktreeDataMap.set("main-wt", {
  id: "main-wt",
  worktreeId: "main-wt",
  name: "main",
  branch: "main",
  path: "/test/root",
  isMainWorktree: true,
});

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: mockWorktreeDataMap }),
}));

const mockSetPendingWorktree = vi.fn();
const mockSelectWorktree = vi.fn();
const mockAddPendingCreation = vi.fn();
const mockFailPendingCreation = vi.fn();
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      setPendingWorktree: mockSetPendingWorktree,
      selectWorktree: mockSelectWorktree,
      addPendingCreation: mockAddPendingCreation,
      failPendingCreation: mockFailPendingCreation,
      activeWorktreeId: null,
    }),
  },
}));

const recipePickerCalls = vi.hoisted(() => ({
  last: null as { startingLayoutRecipes: unknown[]; defaultRecipeId: string | undefined } | null,
}));
// Only `useRecipePicker` is stubbed — `resolveEligibleDefaultRecipeId` stays
// real so the default-eligibility tests exercise the shipping logic rather than
// a copy of it. The module imports nothing but React, so pulling it in is safe.
vi.mock("@/components/Worktree/hooks/useRecipePicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Worktree/hooks/useRecipePicker")>()),
  useRecipePicker: (args: {
    startingLayoutRecipes: unknown[];
    defaultRecipeId: string | undefined;
  }) => {
    recipePickerCalls.last = args;
    return {
      selectedRecipeId: null,
      setSelectedRecipeId: vi.fn(),
      recipePickerOpen: false,
      setRecipePickerOpen: vi.fn(),
      recipeSelectionTouchedRef: { current: false },
      selectedRecipe: null,
    };
  },
}));

const projectSettingsFixture = vi.hoisted(() => ({
  value: null as { defaultWorktreeRecipeId?: string } | null,
}));
vi.mock("@/components/Worktree/hooks/useNewWorktreeProjectSettings", () => ({
  useNewWorktreeProjectSettings: () => ({
    projectSettings: projectSettingsFixture.value,
    configuredBranchPrefix: "",
  }),
}));

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({
    children,
    isOpen,
  }: {
    children: React.ReactNode;
    isOpen: boolean;
    onClose?: () => void;
    onBeforeClose?: () => boolean;
    size?: string;
    dismissible?: boolean;
    "data-testid"?: string;
  }) => (isOpen ? <div data-testid="new-worktree-dialog">{children}</div> : null);
  Dialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.CloseButton = () => <button aria-label="Close" />;
  Dialog.Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { AppDialog: Dialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
    "data-testid"?: string;
  }) => {
    const { variant: _v, size: _s, ...htmlProps } = props as Record<string, unknown>;
    return (
      <button {...(htmlProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    );
  },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => <div data-popover-open={open}>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  PopoverContent: ({
    children,
  }: {
    children: React.ReactNode;
    className?: string;
    align?: string;
    onEscapeKeyDown?: (e: Event) => void;
    onOpenAutoFocus?: (e: Event) => void;
  }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock("@/registry/builtinRendererRegistry", () => ({
  getBuiltinView: () => () => <div data-testid="issue-selector" />,
  useBuiltinView: () => () => <div data-testid="issue-selector" />,
  registerBuiltinView: vi.fn(),
  unregisterBuiltinView: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("./worktreeCreationErrors", async () => {
  return {
    mapCreationError: (msg: string) => ({
      friendly: msg,
      raw: msg,
      recovery: null,
    }),
  };
});

vi.mock("@/components/Worktree/worktreeCreationErrors", () => ({
  mapCreationError: (msg: string) => ({
    friendly: msg,
    raw: msg,
    recovery: null,
  }),
}));

// jsdom doesn't support scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

import { NewWorktreeDialog, clearBranchListCache } from "../NewWorktreeDialog";
import {
  buildCacheKey,
  setCache,
  getCache,
  getGeneration,
  _resetForTests as resetForgeResourceCache,
} from "@/lib/forgeResourceCache";
import type { Issue } from "@shared/types/forge";

beforeEach(() => {
  clearBranchListCache();
});

const TEST_BRANCHES: BranchInfo[] = [
  { name: "main", current: true, commit: "abc123" },
  { name: "develop", current: false, commit: "def456" },
  { name: "feature/existing-work", current: false, commit: "ghi789" },
  { name: "bugfix/old-fix", current: false, commit: "jkl012" },
  { name: "origin/main", current: false, commit: "abc123", remote: "origin" },
  { name: "origin/develop", current: false, commit: "def456", remote: "origin" },
];

async function advanceTimersGradually(totalMs: number, stepMs = 100) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
}

function renderDialog(props: Partial<React.ComponentProps<typeof NewWorktreeDialog>> = {}) {
  return render(
    <NewWorktreeDialog isOpen={true} onClose={vi.fn()} rootPath="/test/root" {...props} />
  );
}

describe("NewWorktreeDialog — existing branch mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockDispatch.mockResolvedValue({ ok: true, result: "new-wt-id" });
    // Default: no authenticated viewer. Existing-branch tests don't exercise
    // self-assignment, and the render effect awaiting an unresolved promise
    // keeps `canAssignIssue` false without leaking toasts/state.
    mockGetCurrentUser.mockResolvedValue(null);
    mockAssignIssue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("shows mode toggle when not in PR checkout mode", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    expect(screen.getByRole("radio", { name: /new branch/i })).toBeDefined();
    expect(screen.getByRole("radio", { name: /existing branch/i })).toBeDefined();
  });

  it("does not show mode toggle in PR checkout mode", async () => {
    renderDialog({
      initialPR: {
        number: 42,
        title: "Test PR",
        body: "",
        headRef: "feature/test",
        baseRef: "main",
        state: "open",
        rawState: "OPEN",
        url: "https://github.com/test/repo/pull/42",
        author: { login: "user", avatarUrl: "", rawData: null },
        isDraft: false,
        merged: false,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      },
    });
    await advanceTimersGradually(500);

    expect(screen.queryByRole("radio", { name: /existing branch/i })).toBeNull();
  });

  it("shows existing branch picker when mode is toggled to existing", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const existingBtn = screen.getByRole("radio", { name: /existing branch/i });
    await act(async () => {
      fireEvent.click(existingBtn);
    });

    expect(screen.getByTestId("existing-branch-picker")).toBeDefined();
    expect(screen.queryByTestId("branch-name-input")).toBeNull();
  });

  it("filters existing branches to local only, excluding in-use", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    // The picker should list local branches: develop, feature/existing-work, bugfix/old-fix
    // "main" is excluded because it's in mockWorktreeDataMap (in use by main-wt)
    // Remote branches (origin/*) are excluded
    const options = screen.getAllByRole("option");
    const names = options.map((el) => el.textContent);
    expect(names).toContain("develop");
    expect(names).toContain("feature/existing-work");
    expect(names).toContain("bugfix/old-fix");
    expect(names).not.toContain("main");
    expect(names).not.toContain("origin/main");
    expect(names).not.toContain("origin/develop");
  });

  it("dispatches useExistingBranch: true when creating with existing branch", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await advanceTimersGradually(500);

    // Switch to existing mode
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    // Select a branch
    const branchOption = screen
      .getAllByRole("option")
      .find((el) => el.textContent === "feature/existing-work");
    expect(branchOption).toBeDefined();
    await act(async () => {
      fireEvent.click(branchOption!);
    });

    // Wait for path generation debounce
    await advanceTimersGradually(500);

    // Click Create
    const createButton = screen.getByTestId("create-worktree-button");
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "worktree.create",
      {
        rootPath: "/test/root",
        options: {
          baseBranch: "feature/existing-work",
          newBranch: "feature/existing-work",
          path: expect.stringContaining("feature/existing-work"),
          fromRemote: false,
          useExistingBranch: true,
          provisionResource: undefined,
          worktreeMode: "local",
        },
      },
      { source: "user" }
    );
  });

  it("does not call getAvailableBranch in existing mode", async () => {
    renderDialog();
    await advanceTimersGradually(500);
    mockGetAvailableBranch.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    // Select a branch
    const branchOption = screen
      .getAllByRole("option")
      .find((el) => el.textContent === "feature/existing-work");
    await act(async () => {
      fireEvent.click(branchOption!);
    });

    await advanceTimersGradually(500);

    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(mockGetDefaultPath).toHaveBeenCalledWith("/test/root", "feature/existing-work");
  });

  // The existing-branch field used to filter with a plain `includes()` and had no
  // key handling at all, one radio toggle away from a fully navigable picker.
  describe("existing-branch search and keyboard parity", () => {
    async function enterExistingMode() {
      renderDialog();
      await advanceTimersGradually(500);
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
      });
    }

    function existingSearch(): HTMLElement {
      return screen.getByLabelText("Search existing branches");
    }

    function optionNames(): string[] {
      return screen.getAllByRole("option").map((el) => el.textContent ?? "");
    }

    async function type(value: string) {
      await act(async () => {
        fireEvent.change(existingSearch(), { target: { value } });
      });
    }

    it("narrows on a single character instead of emptying the list", async () => {
      await enterExistingMode();

      await type("b");

      // Candidates are develop, feature/existing-work, bugfix/old-fix.
      expect(optionNames()).toContain("bugfix/old-fix");
      expect(optionNames()).not.toContain("develop");
    });

    it("narrows on a multi-token query", async () => {
      await enterExistingMode();

      await type("exist work");

      expect(optionNames()).toEqual(["feature/existing-work"]);
    });

    it("selects with arrow keys and Enter", async () => {
      await enterExistingMode();
      expect(optionNames()[0]).toBe("develop");

      await act(async () => {
        fireEvent.keyDown(existingSearch(), { key: "ArrowDown" });
      });
      await act(async () => {
        fireEvent.keyDown(existingSearch(), { key: "Enter" });
      });

      expect(screen.getByTestId("existing-branch-picker").textContent).toContain(
        "feature/existing-work"
      );
    });

    it("moves one cursor that the active descendant follows", async () => {
      await enterExistingMode();

      await act(async () => {
        fireEvent.keyDown(existingSearch(), { key: "ArrowDown" });
      });

      const cursor = screen
        .getAllByRole("option")
        .filter((el) => el.getAttribute("aria-selected") === "true");
      expect(cursor).toHaveLength(1);
      expect(existingSearch().getAttribute("aria-activedescendant")).toBe(cursor[0]!.id);
    });

    it("drops a typed query when the mode toggles away and back", async () => {
      // Deliberately does NOT select a row first: selecting closes the picker,
      // which clears the query on its own, so the assertion would hold even if
      // the mode change reset nothing.
      await enterExistingMode();

      await type("bugfix");
      expect(optionNames()).toEqual(["bugfix/old-fix"]);

      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /new branch/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
      });

      expect((existingSearch() as HTMLInputElement).value).toBe("");
      expect(optionNames()).toContain("develop");
    });

    it("drops the chosen branch when the mode toggles away and back", async () => {
      await enterExistingMode();

      await type("bugfix");
      await act(async () => {
        fireEvent.click(screen.getAllByRole("option")[0]!);
      });
      expect(screen.getByTestId("existing-branch-picker").textContent).toContain("bugfix/old-fix");

      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /new branch/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
      });

      expect(screen.getByTestId("existing-branch-picker").textContent).toContain(
        "Select a local branch"
      );
    });
  });

  it("hides from-remote checkbox in existing mode", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    expect(screen.getByLabelText(/create from remote branch/i)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    expect(screen.queryByLabelText(/create from remote branch/i)).toBeNull();
  });

  it("clears validation errors when switching modes", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    // Click create without a branch name to trigger validation error
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    expect(screen.getByRole("alert")).toBeDefined();

    // Switch to existing mode — error should clear
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables Create button when no existing branch is selected", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    const createButton = screen.getByTestId("create-worktree-button");
    expect(createButton.hasAttribute("disabled")).toBe(true);
  });
});

describe("NewWorktreeDialog — pending creation wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockGetCurrentUser.mockResolvedValue(null);
    mockAssignIssue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("registers a pending creation and closes the dialog before the IPC resolves", async () => {
    // Hold the dispatch promise unresolved so we can assert the synchronous
    // close + placeholder seeding happen first.
    let resolveDispatch: ((value: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve;
        })
    );

    const onClose = vi.fn();
    renderDialog({ onClose });
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "feature/test" } });
    });
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    expect(mockAddPendingCreation).toHaveBeenCalledWith(
      "/test/root-worktrees/feature/test",
      expect.objectContaining({ branch: "feature/test" })
    );
    expect(onClose).toHaveBeenCalled();
    expect(mockFailPendingCreation).not.toHaveBeenCalled();

    // Drain the in-flight IPC so the test doesn't leak the unresolved promise
    // across the cleanup boundary.
    resolveDispatch?.({ ok: true, result: "/test/root-worktrees/feature-test" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("calls failPendingCreation with the failure message when the IPC rejects", async () => {
    mockDispatch.mockResolvedValue({ ok: false, error: { message: "permission denied" } });

    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "feature/test" } });
    });
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });
    // Flush the void-fired async block.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockFailPendingCreation).toHaveBeenCalledWith(
      "/test/root-worktrees/feature/test",
      expect.stringContaining("permission denied")
    );
  });
});

describe("NewWorktreeDialog — branch list cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockDispatch.mockResolvedValue({ ok: true, result: "new-wt-id" });
    mockGetCurrentUser.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the skeleton on first-ever open while branches load", async () => {
    mockListBranches.mockReturnValue(new Promise(() => {}));
    renderDialog();

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryByTestId("branch-name-input")).toBeNull();
  });

  it("renders the form immediately on reopen from the cached branch list", async () => {
    renderDialog();
    await advanceTimersGradually(500);
    cleanup();

    mockListBranches.mockReturnValue(new Promise(() => {}));
    renderDialog();

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("branch-name-input")).toBeDefined();
    expect(document.getElementById("base-branch")?.textContent).toContain("main");
  });

  it("keeps the cached form when the background refresh fails", async () => {
    renderDialog();
    await advanceTimersGradually(500);
    cleanup();

    mockListBranches.mockRejectedValueOnce(new Error("refresh failed"));
    renderDialog();
    await advanceTimersGradually(500);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("branch-name-input")).toBeDefined();
    expect(document.getElementById("base-branch")?.textContent).toContain("main");
  });

  it("resolves a PR head that lives on a non-origin remote without re-fetching", async () => {
    // Fork layout: the forge is `upstream`, so the PR head is only ever
    // tracked as `upstream/<headRef>` (#11747). Probing `origin/<headRef>`
    // misses it and triggers a redundant fetch.
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, commit: "abc123" },
      { name: "upstream/feature/test", current: false, commit: "zzz999", remote: "upstream" },
    ]);
    renderDialog({
      initialPR: {
        number: 42,
        title: "Test PR",
        body: "",
        headRef: "feature/test",
        baseRef: "main",
        state: "open",
        rawState: "OPEN",
        url: "https://github.com/test/repo/pull/42",
        author: { login: "user", avatarUrl: "", rawData: null },
        isDraft: false,
        merged: false,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      },
    });
    await advanceTimersGradually(500);

    expect(mockFetchPRBranch).not.toHaveBeenCalled();
    expect(document.getElementById("base-branch")?.textContent).toContain("upstream/feature/test");
  });

  it("falls through to the PR fetch when two remotes carry the same head name", async () => {
    // A branch name is not a PR identity: origin/feature/test and
    // upstream/feature/test can be different commits, and the dialog has no
    // way to tell which repo the PR belongs to. Building from the wrong one is
    // worse than paying for the authoritative PR-number fetch.
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, commit: "abc123" },
      { name: "origin/feature/test", current: false, commit: "aaa111", remote: "origin" },
      { name: "upstream/feature/test", current: false, commit: "bbb222", remote: "upstream" },
    ]);
    renderDialog({
      initialPR: {
        number: 44,
        title: "Test PR",
        body: "",
        headRef: "feature/test",
        baseRef: "main",
        state: "open",
        rawState: "OPEN",
        url: "https://github.com/test/repo/pull/44",
        author: { login: "user", avatarUrl: "", rawData: null },
        isDraft: false,
        merged: false,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      },
    });
    await advanceTimersGradually(500);

    expect(mockFetchPRBranch).toHaveBeenCalledWith("/test/root", 44, "feature/test");
  });

  it("does not mistake a nested branch for the PR head", async () => {
    // `origin/feature/test` must not satisfy a head named `test` — an exact
    // `<remote>/<headRef>` match, not a suffix match.
    mockListBranches.mockResolvedValue([
      { name: "main", current: true, commit: "abc123" },
      { name: "origin/feature/test", current: false, commit: "zzz999", remote: "origin" },
    ]);
    renderDialog({
      initialPR: {
        number: 43,
        title: "Test PR",
        body: "",
        headRef: "test",
        baseRef: "main",
        state: "open",
        rawState: "OPEN",
        url: "https://github.com/test/repo/pull/43",
        author: { login: "user", avatarUrl: "", rawData: null },
        isDraft: false,
        merged: false,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      },
    });
    await advanceTimersGradually(500);

    expect(mockFetchPRBranch).toHaveBeenCalledWith("/test/root", 43, "test");
  });

  it("bypasses the cache and keeps the skeleton for PR checkout opens", async () => {
    renderDialog();
    await advanceTimersGradually(500);
    cleanup();

    mockListBranches.mockReturnValue(new Promise(() => {}));
    renderDialog({
      initialPR: {
        number: 42,
        title: "Test PR",
        body: "",
        headRef: "feature/test",
        baseRef: "main",
        state: "open",
        rawState: "OPEN",
        url: "https://github.com/test/repo/pull/42",
        author: { login: "user", avatarUrl: "", rawData: null },
        isDraft: false,
        merged: false,
        createdAt: 0,
        updatedAt: 0,
        rawData: null,
      },
    });

    expect(screen.getByRole("status")).toBeDefined();
  });
});

describe("NewWorktreeDialog — ARIA validation wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockDispatch.mockResolvedValue({ ok: true, result: "new-wt-id" });
    mockGetCurrentUser.mockResolvedValue(null);
    mockAssignIssue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("sets aria-invalid and aria-describedby on the new-branch input when branch name is empty", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    expect(branchInput.getAttribute("aria-invalid")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    const alert = screen.getByRole("alert");
    expect(alert.id).toBe("validation-error");
    expect(alert.textContent).toContain("Please enter a branch name");

    expect(branchInput.getAttribute("aria-invalid")).toBe("true");
    expect(branchInput.getAttribute("aria-describedby") ?? "").toContain("validation-error");

    const pathInput = screen.getByTestId("worktree-path-input");
    expect(pathInput.getAttribute("aria-invalid")).toBeNull();

    const baseBranchButton = document.getElementById("base-branch");
    expect(baseBranchButton?.getAttribute("aria-invalid")).toBeNull();
  });

  it("sets aria-invalid on the worktree-path input when path is empty after valid branch name", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "feature/new-feature" } });
    });
    await advanceTimersGradually(1000);

    const pathInput = screen.getByTestId("worktree-path-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: "" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    expect(screen.getByRole("alert").textContent).toContain("Please enter a worktree path");
    expect(pathInput.getAttribute("aria-invalid")).toBe("true");
    expect(pathInput.getAttribute("aria-describedby")).toBe("validation-error");
    expect(branchInput.getAttribute("aria-invalid")).toBeNull();
  });

  it("sets aria-invalid on the base-branch combobox when no base branch is selected", async () => {
    mockListBranches.mockRejectedValueOnce(new Error("no branches"));
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "feature/new" } });
    });
    await advanceTimersGradually(500);

    const baseBranchButton = document.getElementById("base-branch");
    expect(baseBranchButton?.getAttribute("aria-invalid")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    const alerts = screen.getAllByRole("alert");
    const validationAlert = alerts.find((el) => el.id === "validation-error");
    expect(validationAlert).toBeDefined();
    expect(validationAlert?.textContent).toContain("Please select a base branch");

    expect(baseBranchButton?.getAttribute("aria-invalid")).toBe("true");
    expect(baseBranchButton?.getAttribute("aria-describedby")).toBe("validation-error");
  });

  it("clears aria-invalid when the user types in the failing field", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    const branchInput = screen.getByTestId("branch-name-input") as HTMLInputElement;
    expect(branchInput.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "f" } });
    });

    expect(branchInput.getAttribute("aria-invalid")).toBeNull();
    expect(branchInput.getAttribute("aria-describedby") ?? "").not.toContain("validation-error");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears aria-invalid on the failing field when switching modes", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });

    const branchInput = screen.getByTestId("branch-name-input");
    expect(branchInput.getAttribute("aria-invalid")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /existing branch/i }));
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not set aria-invalid on any input on initial render", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    const pathInput = screen.getByTestId("worktree-path-input");
    const baseBranchButton = document.getElementById("base-branch");

    expect(branchInput.getAttribute("aria-invalid")).toBeNull();
    expect(pathInput.getAttribute("aria-invalid")).toBeNull();
    expect(baseBranchButton?.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("NewWorktreeDialog — self-assign cache mutation", () => {
  const ROOT = "/test/root";
  const ISSUE_CACHE_KEY = buildCacheKey(ROOT, "issue", "open", "created");

  function makeIssue(overrides: Partial<Issue> = {}): Issue {
    return {
      number: 42,
      title: "Fix the thing",
      body: "",
      state: "open",
      rawState: "open",
      url: "https://example.com/issues/42",
      assignees: [],
      labels: [],
      createdAt: 0,
      updatedAt: 0,
      rawData: null,
      ...overrides,
    };
  }

  function seedIssueCache(issue: Issue): void {
    setCache(ISSUE_CACHE_KEY, {
      items: [issue],
      nextCursor: null,
      hasMore: false,
      timestamp: 0,
    });
  }

  function cachedIssue(): Issue {
    const entry = getCache(ISSUE_CACHE_KEY);
    if (!entry) throw new Error("expected cache entry to exist");
    return entry.items[0] as Issue;
  }

  // Drive the dialog through a successful create with self-assign enabled.
  async function createWithSelfAssign(): Promise<void> {
    renderDialog({ initialIssue: makeIssue() });
    await advanceTimersGradually(500);

    const branchInput = screen.getByTestId("branch-name-input");
    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "feature/fix-thing" } });
    });
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });
    // Flush the void-fired async create/assign block.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetForgeResourceCache();
    mockAssignWorktreeToSelf = true;
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockDispatch.mockResolvedValue({ ok: true, result: "new-wt-id" });
    mockGetCurrentUser.mockResolvedValue({
      login: "testuser",
      avatarUrl: "https://example.com/avatar.png",
      rawData: null,
    });
    mockAssignIssue.mockResolvedValue(undefined);
    mockUnassignIssue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
    mockAssignWorktreeToSelf = false;
    resetForgeResourceCache();
  });

  it("patches the cached issue assignees after a successful self-assign", async () => {
    seedIssueCache(makeIssue());
    const genBefore = getGeneration(ISSUE_CACHE_KEY);

    await createWithSelfAssign();

    expect(mockAssignIssue).toHaveBeenCalledWith(ROOT, 42, "testuser");
    expect(cachedIssue().assignees.map((a) => a.login)).toContain("testuser");
    // The current user's avatar rides along so the optimistic row matches.
    expect(cachedIssue().assignees.find((a) => a.login === "testuser")?.avatarUrl).toBe(
      "https://example.com/avatar.png"
    );
    // Generation bumps so any in-flight list fetch is discarded.
    expect(getGeneration(ISSUE_CACHE_KEY)).toBeGreaterThan(genBefore);
  });

  it("does not duplicate an already-present assignee", async () => {
    seedIssueCache(
      makeIssue({ assignees: [{ login: "testuser", avatarUrl: undefined, rawData: null }] })
    );
    const genBefore = getGeneration(ISSUE_CACHE_KEY);

    await createWithSelfAssign();

    expect(cachedIssue().assignees.filter((a) => a.login === "testuser")).toHaveLength(1);
    // No effective change → no generation bump (in-flight fetches stay valid).
    expect(getGeneration(ISSUE_CACHE_KEY)).toBe(genBefore);
  });

  it("leaves unrelated issues untouched", async () => {
    const other = makeIssue({ number: 99, assignees: [] });
    setCache(ISSUE_CACHE_KEY, {
      items: [other],
      nextCursor: null,
      hasMore: false,
      timestamp: 0,
    });
    const genBefore = getGeneration(ISSUE_CACHE_KEY);

    await createWithSelfAssign();

    expect((getCache(ISSUE_CACHE_KEY)?.items[0] as Issue).assignees).toHaveLength(0);
    expect(getGeneration(ISSUE_CACHE_KEY)).toBe(genBefore);
  });

  it("auto-dismisses the assign toast instead of leaving it sticky", async () => {
    const { notify } = await import("@/lib/notify");
    seedIssueCache(makeIssue());

    await createWithSelfAssign();

    const assignedCall = vi
      .mocked(notify)
      .mock.calls.find(([payload]) => payload.title === "Issue assigned");
    expect(assignedCall).toBeDefined();
    // The Undo action would otherwise make notify() default this toast to a
    // sticky duration of 0; assert it carries an explicit finite window so it
    // dismisses on its own rather than lingering until manually closed.
    const duration = assignedCall?.[0].duration;
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(10_000);
  });

  it("reverses the optimistic patch when the undo action fires", async () => {
    const { notify } = await import("@/lib/notify");
    seedIssueCache(makeIssue());

    await createWithSelfAssign();
    expect(cachedIssue().assignees.map((a) => a.login)).toContain("testuser");

    const assignedCall = vi
      .mocked(notify)
      .mock.calls.find(([payload]) => payload.title === "Issue assigned");
    expect(assignedCall).toBeDefined();
    const onUndo = assignedCall?.[0].action?.onClick;
    expect(onUndo).toBeTypeOf("function");

    await act(async () => {
      onUndo?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockUnassignIssue).toHaveBeenCalledWith(ROOT, 42, "testuser");
    expect(cachedIssue().assignees.map((a) => a.login)).not.toContain("testuser");
  });

  it("keeps the optimistic patch when the unassign call fails", async () => {
    const { notify } = await import("@/lib/notify");
    mockUnassignIssue.mockRejectedValue(new Error("network down"));
    seedIssueCache(makeIssue());

    await createWithSelfAssign();

    const onUndo = vi
      .mocked(notify)
      .mock.calls.find(([payload]) => payload.title === "Issue assigned")?.[0].action?.onClick;

    await act(async () => {
      onUndo?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    // Unassign rejected → cache must NOT be reverted.
    expect(cachedIssue().assignees.map((a) => a.login)).toContain("testuser");
  });

  it("patches every cached issue slot, not just one filter/sort view", async () => {
    const updatedKey = buildCacheKey(ROOT, "issue", "open", "updated");
    seedIssueCache(makeIssue());
    setCache(updatedKey, {
      items: [makeIssue()],
      nextCursor: null,
      hasMore: false,
      timestamp: 0,
    });

    await createWithSelfAssign();

    expect(cachedIssue().assignees.map((a) => a.login)).toContain("testuser");
    expect((getCache(updatedKey)?.items[0] as Issue).assignees.map((a) => a.login)).toContain(
      "testuser"
    );
  });

  it("does not assign or mutate the cache when self-assign is disabled", async () => {
    mockAssignWorktreeToSelf = false;
    seedIssueCache(makeIssue());

    await createWithSelfAssign();

    expect(mockAssignIssue).not.toHaveBeenCalled();
    expect(cachedIssue().assignees).toHaveLength(0);
    expect(getGeneration(ISSUE_CACHE_KEY)).toBe(0);
  });

  it("skips the assign flow when the selected issue already lists the current user", async () => {
    seedIssueCache(makeIssue());

    renderDialog({
      initialIssue: makeIssue({
        assignees: [{ login: "testuser", avatarUrl: undefined, rawData: null }],
      }),
    });
    await advanceTimersGradually(500);
    const branchInput = screen.getByTestId("branch-name-input");
    await act(async () => {
      fireEvent.change(branchInput, { target: { value: "feature/fix-thing" } });
    });
    await advanceTimersGradually(500);
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockAssignIssue).not.toHaveBeenCalled();
    expect(getGeneration(ISSUE_CACHE_KEY)).toBe(0);
  });
});

describe("NewWorktreeDialog — recipe scope visibility (#11510)", () => {
  const GLOBAL_WORK = { id: "global-work", name: "Work", terminals: [], createdAt: 0 };
  const SHADOWED_WORK = {
    id: "project-work",
    name: "Work",
    projectId: "project-1",
    shadowedBy: "Work",
    terminals: [],
    createdAt: 0,
  };
  const WORKTREE_ONLY = {
    id: "wt-scoped",
    name: "Scoped",
    projectId: "project-1",
    worktreeId: "wt-1",
    terminals: [],
    createdAt: 0,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockGetCurrentUser.mockResolvedValue(null);
    recipePickerCalls.last = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
    recipeFixtures.recipes = [];
    projectSettingsFixture.value = null;
  });

  it("keeps a shadowed recipe in the picker list instead of hiding it", async () => {
    recipeFixtures.recipes = [GLOBAL_WORK, SHADOWED_WORK, WORKTREE_ONLY];

    renderDialog();
    await advanceTimersGradually(500);

    const listed = (recipePickerCalls.last?.startingLayoutRecipes ?? []) as { id: string }[];
    expect(listed.map((r) => r.id)).toEqual(["global-work", "project-work"]);
  });

  it("does not promote a shadowed recipe to the implicit default", async () => {
    // A shadowed recipe never runs its own terminals, so RecipesTab reports the
    // pinned default as unavailable. The picker has to agree rather than
    // silently marking the losing row "(default)".
    recipeFixtures.recipes = [SHADOWED_WORK];
    projectSettingsFixture.value = { defaultWorktreeRecipeId: "project-work" };

    renderDialog();
    await advanceTimersGradually(500);

    // Assert the call happened first — a bare optional chain would also pass if
    // the picker were never invoked at all.
    expect(recipePickerCalls.last).not.toBeNull();
    expect(recipePickerCalls.last?.defaultRecipeId).toBeUndefined();
  });

  it("still forwards an unshadowed pinned default", async () => {
    recipeFixtures.recipes = [GLOBAL_WORK];
    projectSettingsFixture.value = { defaultWorktreeRecipeId: "global-work" };

    renderDialog();
    await advanceTimersGradually(500);

    expect(recipePickerCalls.last?.defaultRecipeId).toBe("global-work");
  });
});

describe("NewWorktreeDialog — in-use base branch selection", () => {
  // `main` is in use by `main-wt` via mockWorktreeDataMap. Make `develop` the
  // current branch so it wins deriveDefaultBaseBranch — otherwise `main` is
  // already the default and clicking it would change nothing observable.
  const BRANCHES_WITH_DEVELOP_CURRENT: BranchInfo[] = TEST_BRANCHES.map((b) => ({
    ...b,
    current: b.name === "develop",
  }));

  const IN_USE_BRANCH = "main";

  function baseBranchLabel(): string {
    return document.getElementById("base-branch")?.textContent ?? "";
  }

  /** Match on the row's label span so `main` never resolves to `origin/main`. */
  function baseBranchOption(label: string): HTMLElement {
    const list = document.getElementById("branch-list");
    if (!list) throw new Error("base-branch listbox not rendered");
    const row = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.querySelector("span")?.textContent === label
    );
    if (!row) throw new Error(`no base-branch row labelled "${label}"`);
    return row;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(BRANCHES_WITH_DEVELOP_CURRENT);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockDispatch.mockResolvedValue({ ok: true, result: "new-wt-id" });
    mockGetCurrentUser.mockResolvedValue(null);
    mockAssignIssue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it("selects an in-use branch as the base without closing the dialog or switching worktrees", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await advanceTimersGradually(500);

    expect(baseBranchLabel()).toBe("develop (current)");

    const row = baseBranchOption(IN_USE_BRANCH);
    expect(row.querySelector('[title^="In use by worktree:"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(row);
    });

    // Exact, not substring: `toContain("main")` would also accept `origin/main`.
    expect(baseBranchLabel()).toBe(IN_USE_BRANCH);
    // `aria-current`, not `aria-selected`: the latter tracks the keyboard cursor,
    // which sits on row 0 regardless, so it would pass without a selection.
    expect(baseBranchOption(IN_USE_BRANCH).getAttribute("aria-current")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    expect(mockDispatch.mock.calls.map((c) => c[0])).not.toContain("worktree.setActive");
  });

  it("reaches the same selection with Enter as with a click", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await advanceTimersGradually(500);

    // selectedIndex starts at 0, so Enter targets whichever row leads the list.
    expect(baseBranchOption(IN_USE_BRANCH).getAttribute("data-option-index")).toBe("0");

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Search base branches"), { key: "Enter" });
    });

    expect(baseBranchLabel()).toBe(IN_USE_BRANCH);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockDispatch.mock.calls.map((c) => c[0])).not.toContain("worktree.setActive");
  });

  it("preserves a typed branch name across an in-use base-branch selection", async () => {
    // renderDialog() pins isOpen={true}, so it can never unmount and any
    // "still mounted"/"input survived" assertion against it passes even with the
    // bug present. Drive `isOpen` from onClose so the close actually unmounts.
    function ControlledDialog() {
      const [open, setOpen] = useState(true);
      return open ? (
        <NewWorktreeDialog isOpen onClose={() => setOpen(false)} rootPath="/test/root" />
      ) : null;
    }

    render(<ControlledDialog />);
    await advanceTimersGradually(500);

    await act(async () => {
      fireEvent.change(screen.getByTestId("branch-name-input"), {
        target: { value: "feature/keep-me" },
      });
    });
    await advanceTimersGradually(1000);

    await act(async () => {
      fireEvent.click(baseBranchOption(IN_USE_BRANCH));
    });

    expect(screen.queryByTestId("new-worktree-dialog")).not.toBeNull();
    expect(screen.getByTestId<HTMLInputElement>("branch-name-input").value).toBe("feature/keep-me");
  });
});

describe("NewWorktreeDialog — deferred branch auto-resolve", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListBranches.mockResolvedValue(TEST_BRANCHES);
    mockGetRecentBranches.mockResolvedValue([]);
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name === "feature/terrain" ? "feature/terrain-2" : name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/test/root-worktrees/${branch}`)
    );
    mockDispatch.mockResolvedValue({ ok: true, result: "new-wt-id" });
    mockGetCurrentUser.mockResolvedValue(null);
    mockAssignIssue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  async function typeBranch(value: string) {
    const branchInput = screen.getByTestId("branch-name-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(branchInput, { target: { value } });
    });
    await advanceTimersGradually(500);
    return branchInput;
  }

  it("leaves the typed name in place while flagging the conflict", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = await typeBranch("feature/terrain");

    expect(branchInput.value).toBe("feature/terrain");
    expect(screen.getByText(/renamed to avoid a conflict/i)).toBeDefined();
  });

  it("does not clobber characters typed past the conflicting prefix", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = await typeBranch("feature/terrain");
    // Resume typing from whatever the field actually holds. Replacing the value
    // outright would mask a rewrite, since it overwrites the damage too.
    await typeBranch(`${branchInput.value}-shadows`);

    expect(branchInput.value).toBe("feature/terrain-shadows");
    expect(screen.queryByText(/renamed to avoid a conflict/i)).toBeNull();
  });

  it("applies the auto-incremented name on blur without re-checking or disabling Create", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = await typeBranch("feature/terrain");
    const pathInput = screen.getByTestId("worktree-path-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: "/custom/path" } });
    });
    mockGetAvailableBranch.mockClear();
    mockGetDefaultPath.mockClear();

    await act(async () => {
      fireEvent.blur(branchInput);
    });

    expect(branchInput.value).toBe("feature/terrain-2");
    // Skipping the re-check is what keeps a hand-edited path from being
    // regenerated out from under the user.
    expect(pathInput.value).toBe("/custom/path");
    // Re-checking a name we already know is free would re-disable Create in the
    // gap between the blur and the click that caused it, swallowing the click.
    const createButton = screen.getByTestId("create-worktree-button") as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);

    await advanceTimersGradually(500);
    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(mockGetDefaultPath).not.toHaveBeenCalled();
  });

  it("creates the auto-incremented branch when Create follows a blur", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = await typeBranch("feature/terrain");
    // The rewrite must be the blur's doing, not the debounce's.
    expect(branchInput.value).toBe("feature/terrain");

    await act(async () => {
      fireEvent.blur(branchInput);
    });
    expect(branchInput.value).toBe("feature/terrain-2");

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockAddPendingCreation).toHaveBeenCalledWith(
      "/test/root-worktrees/feature/terrain",
      expect.objectContaining({ branch: "feature/terrain-2" })
    );
    expect(mockDispatch).toHaveBeenCalledWith(
      "worktree.create",
      expect.objectContaining({
        options: expect.objectContaining({ newBranch: "feature/terrain-2" }),
      }),
      expect.anything()
    );
  });

  it("creates the auto-incremented branch when Create fires without a blur", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = await typeBranch("feature/terrain");
    // The field still holds what was typed — Create has to resolve it itself.
    expect(branchInput.value).toBe("feature/terrain");

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "worktree.create",
      expect.objectContaining({
        options: expect.objectContaining({ newBranch: "feature/terrain-2" }),
      }),
      expect.anything()
    );
  });

  it("creates the typed name when no conflict was detected", async () => {
    renderDialog();
    await advanceTimersGradually(500);

    const branchInput = await typeBranch("feature/canyon");
    await act(async () => {
      fireEvent.blur(branchInput);
    });
    // Blur leaves an unconflicted name untouched.
    expect(branchInput.value).toBe("feature/canyon");

    await act(async () => {
      fireEvent.click(screen.getByTestId("create-worktree-button"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      "worktree.create",
      expect.objectContaining({
        options: expect.objectContaining({ newBranch: "feature/canyon" }),
      }),
      expect.anything()
    );
  });
});
