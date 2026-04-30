/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
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
  githubClient: {
    assignIssue: vi.fn(),
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
vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(() => ({ recipes: [], runRecipe: vi.fn() }), {
    getState: () => ({
      runRecipeWithResults: vi.fn(),
      getRecipeById: () => null,
      generateRecipeFromActiveTerminals: mockGenerateRecipeFromActiveTerminals,
    }),
  }),
}));

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      assignWorktreeToSelf: false,
      setAssignWorktreeToSelf: vi.fn(),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: vi.fn(),
    }),
}));

vi.mock("@/store/githubConfigStore", () => ({
  useGitHubConfigStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ config: null, initialize: vi.fn(), refresh: vi.fn() }),
    { getState: () => ({ config: null }) }
  ),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentProject: { id: "test-project", path: "/test/root" } }),
}));

const mockWorktreeDataMap = new Map();
mockWorktreeDataMap.set("main-wt", {
  worktreeId: "main-wt",
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
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      setPendingWorktree: mockSetPendingWorktree,
      selectWorktree: mockSelectWorktree,
    }),
  },
}));

vi.mock("@/components/Worktree/hooks/useRecipePicker", () => ({
  CLONE_LAYOUT_ID: "__clone_layout__",
  useRecipePicker: () => ({
    selectedRecipeId: null,
    setSelectedRecipeId: vi.fn(),
    recipePickerOpen: false,
    setRecipePickerOpen: vi.fn(),
    recipeSelectionTouchedRef: { current: false },
    selectedRecipe: null,
  }),
}));

vi.mock("@/components/Worktree/hooks/useNewWorktreeProjectSettings", () => ({
  useNewWorktreeProjectSettings: () => ({
    projectSettings: null,
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

vi.mock("@/components/GitHub/IssueSelector", () => ({
  IssueSelector: () => <div data-testid="issue-selector" />,
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

import { NewWorktreeDialog } from "../NewWorktreeDialog";

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
        headRefName: "feature/test",
        state: "OPEN",
        url: "https://github.com/test/repo/pull/42",
        author: { login: "user", avatarUrl: "" },
        isDraft: false,
        updatedAt: new Date().toISOString(),
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
