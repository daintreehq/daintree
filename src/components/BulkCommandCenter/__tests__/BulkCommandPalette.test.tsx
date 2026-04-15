// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BulkCommandPalette, openBulkCommandPalette } from "../BulkCommandPalette";
import { usePaletteStore } from "@/store/paletteStore";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
  useEscapeStack: vi.fn(),
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/lib/animationUtils", () => ({
  UI_ENTER_DURATION: 0,
  UI_EXIT_DURATION: 0,
  UI_ENTER_EASING: "ease",
  UI_EXIT_EASING: "ease",
  getUiTransitionDuration: () => 0,
}));

const mockSendKey = vi.fn();
const mockSubmit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/clients", () => ({
  terminalClient: {
    sendKey: (...args: unknown[]) => mockSendKey(...args),
    submit: (...args: unknown[]) => mockSubmit(...args),
  },
}));

vi.mock("@/components/Worktree/AgentStatusIndicator", () => ({
  getDominantAgentState: (states: (string | undefined)[]) => {
    const valid = states.filter(Boolean);
    return valid.length > 0 ? valid[0] : null;
  },
}));

vi.mock("@/components/Worktree/terminalStateConfig", () => {
  const Icon =
    (name: string) =>
    ({ className }: { className?: string }) => (
      <span data-testid={`state-icon-${name}`} className={className}>
        {name[0]}
      </span>
    );
  return {
    STATE_ICONS: {
      working: Icon("working"),
      running: Icon("running"),
      waiting: Icon("waiting"),
      directing: Icon("directing"),
      idle: Icon("idle"),
      completed: Icon("completed"),
      exited: Icon("exited"),
    },
    STATE_COLORS: {
      working: "text-state-working",
      running: "text-status-info",
      waiting: "text-state-waiting",
      directing: "text-category-blue",
      idle: "text-daintree-text/40",
      completed: "text-state-completed",
      exited: "text-daintree-text/40",
    },
    STATE_LABELS: {
      working: "working",
      running: "running",
      waiting: "waiting",
      directing: "directing",
      idle: "idle",
      completed: "done",
      exited: "exited",
    },
  };
});

vi.mock("@/utils/terminalType", () => ({
  isAgentTerminal: (kindOrType?: string, agentId?: string) => kindOrType === "agent" || !!agentId,
}));

vi.mock("p-queue", () => ({
  default: class MockPQueue {
    concurrency: number;
    constructor(opts: { concurrency: number }) {
      this.concurrency = opts.concurrency;
    }
    async add(fn: () => Promise<unknown>) {
      return fn();
    }
    async addAll(fns: (() => Promise<unknown>)[]) {
      for (const fn of fns) await fn();
    }
    clear() {}
  },
}));

const mockRecordPrompt = vi.fn();
const mockGetProjectHistory = vi.fn().mockReturnValue([]);
vi.mock("@/store/commandHistoryStore", () => ({
  useCommandHistoryStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ getProjectHistory: mockGetProjectHistory }),
    {
      getState: () => ({
        recordPrompt: mockRecordPrompt,
      }),
    }
  ),
}));

const mockAddNotification = vi.fn().mockReturnValue("notif-1");
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ notifications: [] }),
    {
      getState: () => ({
        addNotification: mockAddNotification,
      }),
    }
  ),
}));

vi.mock("@/utils/recipeVariables", async () => {
  const actual = await vi.importActual("@/utils/recipeVariables");
  return {
    ...actual,
    getAvailableVariables: () => [
      { name: "issue_number", description: "GitHub issue number" },
      { name: "pr_number", description: "GitHub PR number" },
      { name: "worktree_path", description: "Absolute path to worktree directory" },
      { name: "branch_name", description: "Git branch name" },
    ],
  };
});

const mockRunRecipeWithResults = vi
  .fn()
  .mockResolvedValue({ spawned: [{ index: 0, terminalId: "t-new" }], failed: [] });

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        recipes: [
          {
            id: "recipe-1",
            name: "Dev Setup",
            worktreeId: undefined,
            terminals: [{ type: "claude", title: "Agent" }],
          },
          {
            id: "recipe-wt",
            name: "WT Specific",
            worktreeId: "wt-1",
            terminals: [{ type: "terminal" }],
          },
        ],
      }),
    {
      getState: () => ({
        runRecipeWithResults: mockRunRecipeWithResults,
      }),
    }
  ),
}));

const mockWorktrees = new Map([
  [
    "wt-1",
    {
      id: "wt-1",
      name: "feature-a",
      branch: "feature/a",
      isMainWorktree: false,
      path: "/tmp/wt1",
      issueNumber: 101,
      prNumber: 201,
    },
  ],
  [
    "wt-2",
    {
      id: "wt-2",
      name: "feature-b",
      branch: "feature/b",
      isMainWorktree: false,
      path: "/tmp/wt2",
      issueNumber: undefined,
      prNumber: undefined,
    },
  ],
  [
    "wt-3",
    {
      id: "wt-3",
      name: "feature-c",
      branch: "feature/c",
      isMainWorktree: false,
      path: "/tmp/wt3",
      issueNumber: 103,
      prNumber: undefined,
    },
  ],
  [
    "wt-main",
    {
      id: "wt-main",
      name: "main",
      branch: "main",
      isMainWorktree: true,
      path: "/tmp/main",
    },
  ],
]);

const mockTerminals = [
  {
    id: "t1",
    worktreeId: "wt-1",
    kind: "agent",
    agentId: "claude",
    agentState: "working",
    location: "grid",
    hasPty: true,
  },
  {
    id: "t2",
    worktreeId: "wt-1",
    kind: "agent",
    agentId: "claude",
    agentState: "idle",
    location: "grid",
    hasPty: true,
  },
  {
    id: "t3",
    worktreeId: "wt-2",
    kind: "agent",
    agentId: "claude",
    agentState: "waiting",
    location: "grid",
    hasPty: true,
  },
  {
    id: "t4",
    worktreeId: "wt-2",
    kind: "terminal",
    location: "grid",
    hasPty: true,
  },
  {
    id: "t5",
    worktreeId: "wt-1",
    kind: "agent",
    agentId: "claude",
    agentState: "idle",
    location: "trash",
    hasPty: true,
  },
  {
    id: "t6",
    worktreeId: "wt-3",
    kind: "agent",
    agentId: "claude",
    agentState: undefined,
    location: "grid",
    hasPty: true,
  },
];

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: typeof mockWorktrees }) => unknown) =>
    selector({ worktrees: mockWorktrees }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(
    (
      selector: (s: {
        panelsById: Record<string, (typeof mockTerminals)[number]>;
        panelIds: string[];
      }) => unknown
    ) =>
      selector({
        panelsById: Object.fromEntries(mockTerminals.map((t) => [t.id, t])),
        panelIds: mockTerminals.map((t) => t.id),
      }),
    {
      getState: () => ({
        panelsById: Object.fromEntries(mockTerminals.map((t) => [t.id, t])),
        panelIds: mockTerminals.map((t) => t.id),
      }),
    }
  ),
}));

function openPalette() {
  act(() => {
    usePaletteStore.getState().openPalette("bulk-command");
  });
}

describe("BulkCommandPalette", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSendKey.mockClear();
    mockSubmit.mockClear();
    mockRunRecipeWithResults.mockClear();
    mockRecordPrompt.mockClear();
    mockAddNotification.mockClear();
    mockGetProjectHistory.mockReturnValue([]);
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render when closed", () => {
    render(<BulkCommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders worktree rows including main worktree when open", () => {
    render(<BulkCommandPalette />);
    openPalette();
    expect(screen.getByText("feature/a")).toBeTruthy();
    expect(screen.getByText("feature/b")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });

  it("renders main worktree as disabled when it has no agent terminals", () => {
    render(<BulkCommandPalette />);
    openPalette();
    const checkbox = screen.getByTestId("bulk-worktree-checkbox-wt-main") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it("shows agent terminal count per worktree", () => {
    render(<BulkCommandPalette />);
    openPalette();
    expect(screen.getByText("2 agents")).toBeTruthy(); // wt-1 has 2 (t1, t2), t5 is trashed
    expect(screen.getAllByText("1 agent").length).toBeGreaterThanOrEqual(1); // wt-2 and wt-3 each have 1
  });

  it("toggles worktree selection via branch click (selects all child terminals)", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    const wtCheckbox = screen.getByTestId("bulk-worktree-checkbox-wt-1") as HTMLInputElement;
    const t1Checkbox = screen.getByTestId("bulk-terminal-checkbox-t1") as HTMLInputElement;
    const t2Checkbox = screen.getByTestId("bulk-terminal-checkbox-t2") as HTMLInputElement;
    expect(wtCheckbox.checked).toBe(true);
    expect(t1Checkbox.checked).toBe(true);
    expect(t2Checkbox.checked).toBe(true);
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    expect(wtCheckbox.checked).toBe(false);
    expect(t1Checkbox.checked).toBe(false);
    expect(t2Checkbox.checked).toBe(false);
  });

  it("toggling a single terminal shows the worktree checkbox as indeterminate", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId("bulk-terminal-checkbox-t1"));
    const wtCheckbox = screen.getByTestId("bulk-worktree-checkbox-wt-1") as HTMLInputElement;
    const t1Checkbox = screen.getByTestId("bulk-terminal-checkbox-t1") as HTMLInputElement;
    const t2Checkbox = screen.getByTestId("bulk-terminal-checkbox-t2") as HTMLInputElement;
    expect(t1Checkbox.checked).toBe(true);
    expect(t2Checkbox.checked).toBe(false);
    expect(wtCheckbox.checked).toBe(false);
    expect(wtCheckbox.indeterminate).toBe(true);
    expect(wtCheckbox.getAttribute("aria-checked")).toBe("mixed");
  });

  it("worktree checkbox becomes fully checked (non-indeterminate) when all children selected", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId("bulk-terminal-checkbox-t1"));
    fireEvent.click(screen.getByTestId("bulk-terminal-checkbox-t2"));
    const wtCheckbox = screen.getByTestId("bulk-worktree-checkbox-wt-1") as HTMLInputElement;
    expect(wtCheckbox.checked).toBe(true);
    expect(wtCheckbox.indeterminate).toBe(false);
  });

  it("expand button toggles the row's aria-expanded state", () => {
    render(<BulkCommandPalette />);
    openPalette();
    const row = screen.getByTestId("bulk-worktree-row-wt-1");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("bulk-worktree-expand-wt-1"));
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("bulk-worktree-expand-wt-1"));
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("disabled worktrees do not show an expand affordance", () => {
    render(<BulkCommandPalette />);
    openPalette();
    const row = screen.getByTestId("bulk-worktree-row-wt-main");
    expect(row.getAttribute("aria-expanded")).toBeNull();
    const expandBtn = screen.getByTestId("bulk-worktree-expand-wt-main") as HTMLButtonElement;
    expect(expandBtn.disabled).toBe(true);
  });

  it("select all toggles all enabled rows (worktree + terminal checkboxes)", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Select All"));
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const enabled = checkboxes.filter((c) => !c.disabled);
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every((c) => c.checked)).toBe(true);
    fireEvent.click(screen.getByText("Deselect All"));
    expect(enabled.every((c) => !c.checked)).toBe(true);
  });

  it("disables send button when no worktrees selected", () => {
    render(<BulkCommandPalette />);
    openPalette();
    const sendBtn = screen.getByText("Send").closest("button") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it("sends keystroke to all agent terminals in selected worktrees", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    fireEvent.click(screen.getByText("Send"));
    expect(mockSendKey).toHaveBeenCalledTimes(2);
    expect(mockSendKey).toHaveBeenCalledWith("t1", "escape");
    expect(mockSendKey).toHaveBeenCalledWith("t2", "escape");
  });

  it("sends keystroke to only individually selected terminal", () => {
    render(<BulkCommandPalette />);
    openPalette();
    // Select only t1, leaving t2 (same worktree) untouched
    fireEvent.click(screen.getByTestId("bulk-terminal-checkbox-t1"));
    fireEvent.click(screen.getByText("Send"));
    expect(mockSendKey).toHaveBeenCalledTimes(1);
    expect(mockSendKey).toHaveBeenCalledWith("t1", "escape");
  });

  it("sends double-escape with 1s delay after confirmation", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("feature/b").closest("button")!);
    fireEvent.click(screen.getByText("Double Escape"));
    const sendBtn = screen.getByRole("button", { name: "Send" });
    fireEvent.click(sendBtn);
    // Should show confirmation instead of sending
    expect(mockSendKey).toHaveBeenCalledTimes(0);
    expect(screen.getByText(/Send Double Escape to 1 agent\?/)).toBeTruthy();
    // Click Confirm to actually send
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(mockSendKey).toHaveBeenCalledTimes(1);
    expect(mockSendKey).toHaveBeenCalledWith("t3", "escape");
    act(() => vi.advanceTimersByTime(1000));
    expect(mockSendKey).toHaveBeenCalledTimes(2);
  });

  it("shows Preview button in text mode and transitions to preview step", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    const input = screen.getByPlaceholderText(/Type a command/);
    fireEvent.change(input, { target: { value: "npm test" } });
    expect(screen.getByText("Preview")).toBeTruthy();
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("← Back")).toBeTruthy();
    expect(screen.getByText("feature/a")).toBeTruthy();
  });

  it("sends text command per worktree after confirm in preview", async () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    const input = screen.getByPlaceholderText(/Type a command/);
    fireEvent.change(input, { target: { value: "npm test" } });
    fireEvent.click(screen.getByText("Preview"));
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm"));
    });
    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(mockSubmit).toHaveBeenCalledWith("t1", "npm test");
    expect(mockSubmit).toHaveBeenCalledWith("t2", "npm test");
  });

  it("text-mode send targets only individually selected terminals", async () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    // Select only t2, not t1 in the same worktree
    fireEvent.click(screen.getByTestId("bulk-terminal-checkbox-t2"));
    const input = screen.getByPlaceholderText(/Type a command/);
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.click(screen.getByText("Preview"));
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm"));
    });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith("t2", "echo hi");
  });

  it("resolves template variables per worktree in preview", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    fireEvent.click(screen.getByText("feature/b").closest("button")!);
    const input = screen.getByPlaceholderText(/Type a command/);
    fireEvent.change(input, { target: { value: "fix {{issue_number}}" } });
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("fix #101")).toBeTruthy();
    expect(screen.getByText("fix")).toBeTruthy();
  });

  it("shows unresolved variable warnings in preview", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/b").closest("button")!);
    const input = screen.getByPlaceholderText(/Type a command/);
    fireEvent.change(input, { target: { value: "fix {{issue_number}}" } });
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText(/Missing:.*issue_number/)).toBeTruthy();
  });

  it("disables send in text mode when command is empty", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    const previewBtn = screen.getByText("Preview").closest("button") as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
  });

  it("openBulkCommandPalette sets palette store", () => {
    openBulkCommandPalette();
    expect(usePaletteStore.getState().activePaletteId).toBe("bulk-command");
  });

  it("resets state when palette closes", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    act(() => usePaletteStore.getState().closePalette("bulk-command"));
    openPalette();
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.every((c) => !c.checked)).toBe(true);
  });

  describe("state presets", () => {
    it("renders preset buttons with terminal-level counts", () => {
      render(<BulkCommandPalette />);
      openPalette();
      // Active: t1 (working). Waiting: t3. Idle: t2 (idle) + t6 (undefined→null) = 2.
      expect(screen.getByText("Active (1)")).toBeTruthy();
      expect(screen.getByText("Waiting (1)")).toBeTruthy();
      expect(screen.getByText("Idle (2)")).toBeTruthy();
      expect(screen.getByText("Completed (0)")).toBeTruthy();
    });

    it("Active preset selects only matching terminals, not siblings in same worktree", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Active (1)"));
      const t1 = screen.getByTestId("bulk-terminal-checkbox-t1") as HTMLInputElement;
      const t2 = screen.getByTestId("bulk-terminal-checkbox-t2") as HTMLInputElement;
      const wt1 = screen.getByTestId("bulk-worktree-checkbox-wt-1") as HTMLInputElement;
      // t1 is "working" → selected; t2 is "idle" in the same worktree → not selected
      expect(t1.checked).toBe(true);
      expect(t2.checked).toBe(false);
      // parent shows indeterminate
      expect(wt1.checked).toBe(false);
      expect(wt1.indeterminate).toBe(true);
    });

    it("Waiting preset selects terminals with waiting state", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Waiting (1)"));
      const t3 = screen.getByTestId("bulk-terminal-checkbox-t3") as HTMLInputElement;
      const wt2 = screen.getByTestId("bulk-worktree-checkbox-wt-2") as HTMLInputElement;
      expect(t3.checked).toBe(true);
      // wt-2 has only t3 as eligible agent → fully selected
      expect(wt2.checked).toBe(true);
    });

    it("Idle preset selects idle and stateless terminals across worktrees", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Idle (2)"));
      const t2 = screen.getByTestId("bulk-terminal-checkbox-t2") as HTMLInputElement;
      const t6 = screen.getByTestId("bulk-terminal-checkbox-t6") as HTMLInputElement;
      expect(t2.checked).toBe(true);
      expect(t6.checked).toBe(true);
    });

    it("presets are additive - do not clear existing selection", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      fireEvent.click(screen.getByText("Waiting (1)"));
      const wt1 = screen.getByTestId("bulk-worktree-checkbox-wt-1") as HTMLInputElement;
      const wt2 = screen.getByTestId("bulk-worktree-checkbox-wt-2") as HTMLInputElement;
      expect(wt1.checked).toBe(true);
      expect(wt2.checked).toBe(true);
    });
  });

  describe("recipe mode", () => {
    it("shows Recipe mode toggle button", () => {
      render(<BulkCommandPalette />);
      openPalette();
      expect(screen.getByText("Recipe")).toBeTruthy();
    });

    it("shows only project-wide recipes in recipe mode", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Recipe"));
      expect(screen.getByText("Dev Setup")).toBeTruthy();
      expect(screen.queryByText("WT Specific")).toBeNull();
    });

    it("disables Preview when no recipe is selected", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Recipe"));
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      const previewBtn = screen.getByText("Preview").closest("button") as HTMLButtonElement;
      expect(previewBtn.disabled).toBe(true);
    });

    it("enables Preview when recipe and worktrees are selected", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Recipe"));
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      fireEvent.click(screen.getByText("Dev Setup"));
      const previewBtn = screen.getByText("Preview").closest("button") as HTMLButtonElement;
      expect(previewBtn.disabled).toBe(false);
    });

    it("broadcasts recipe to selected worktrees on confirm", async () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Recipe"));
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      fireEvent.click(screen.getByText("feature/b").closest("button")!);
      fireEvent.click(screen.getByText("Dev Setup"));
      fireEvent.click(screen.getByText("Preview"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm"));
      });
      expect(mockRunRecipeWithResults).toHaveBeenCalledTimes(2);
      expect(mockRunRecipeWithResults).toHaveBeenCalledWith("recipe-1", "/tmp/wt1", "wt-1", {
        issueNumber: 101,
        prNumber: 201,
        worktreePath: "/tmp/wt1",
        branchName: "feature/a",
      });
      expect(mockRunRecipeWithResults).toHaveBeenCalledWith("recipe-1", "/tmp/wt2", "wt-2", {
        issueNumber: undefined,
        prNumber: undefined,
        worktreePath: "/tmp/wt2",
        branchName: "feature/b",
      });
    });
  });

  it("resets step when mode changes", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    const input = screen.getByPlaceholderText(/Type a command/);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText("← Back")).toBeTruthy();
    // Switch mode — should reset to select step
    fireEvent.click(screen.getByText("Keystroke"));
    expect(screen.queryByText("← Back")).toBeNull();
  });

  describe("variable chips", () => {
    it("renders variable chip buttons in text mode", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Text Command"));
      expect(screen.getByText("{{issue_number}}")).toBeTruthy();
      expect(screen.getByText("{{branch_name}}")).toBeTruthy();
      expect(screen.getByText("{{pr_number}}")).toBeTruthy();
      expect(screen.getByText("{{worktree_path}}")).toBeTruthy();
    });

    it("shows caption text below chips", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Text Command"));
      expect(screen.getByText(/Click to insert/)).toBeTruthy();
      expect(screen.getByText(/Variables resolve per worktree/)).toBeTruthy();
    });
  });

  describe("destructive keystroke confirmation", () => {
    it("ctrl+c shows confirmation before sending", () => {
      render(<BulkCommandPalette />);
      openPalette();
      // Click single terminal (t3 in wt-2) to select exactly 1 agent
      fireEvent.click(screen.getByTestId("bulk-terminal-checkbox-t3"));
      fireEvent.click(screen.getByText("Ctrl+C"));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(mockSendKey).not.toHaveBeenCalled();
      expect(screen.getByText(/Send Ctrl\+C to 1 agent\?/)).toBeTruthy();
    });

    it("non-destructive keystrokes send immediately", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      // Escape is already default, should send immediately
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(mockSendKey).toHaveBeenCalledTimes(2);
    });

    it("cancel dismisses confirmation", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      fireEvent.click(screen.getByText("Ctrl+C"));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText(/Send Ctrl\+C/)).toBeNull();
      expect(screen.getByText("Ctrl+C")).toBeTruthy();
    });
  });

  describe("post-execution toast", () => {
    it("emits notification toast after text command confirm", async () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Text Command"));
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      const input = screen.getByPlaceholderText(/Type a command/);
      fireEvent.change(input, { target: { value: "npm test" } });
      fireEvent.click(screen.getByText("Preview"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm"));
      });
      expect(mockAddNotification).toHaveBeenCalledTimes(1);
      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", priority: "low" })
      );
    });

    it("records command in history after text confirm", async () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Text Command"));
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      const input = screen.getByPlaceholderText(/Type a command/);
      fireEvent.change(input, { target: { value: "npm test" } });
      fireEvent.click(screen.getByText("Preview"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm"));
      });
      expect(mockRecordPrompt).toHaveBeenCalledWith("bulk-commands", "npm test");
    });
  });

  describe("footer", () => {
    it("shows worktree and agent count", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      expect(screen.getByText(/1 worktree, 2 agents/)).toBeTruthy();
    });

    it("shows keyboard hints", () => {
      render(<BulkCommandPalette />);
      openPalette();
      expect(screen.getByText(/Navigate/)).toBeTruthy();
      expect(screen.getByText(/Esc Back/)).toBeTruthy();
    });
  });

  describe("command history", () => {
    it("shows history dropdown when input is empty and focused", () => {
      mockGetProjectHistory.mockReturnValue([
        { id: "h1", prompt: "npm test", agentId: null, addedAt: 1 },
        { id: "h2", prompt: "npm run build", agentId: null, addedAt: 2 },
      ]);
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Text Command"));
      const input = screen.getByPlaceholderText(/Type a command/);
      fireEvent.focus(input);
      expect(screen.getByText("npm test")).toBeTruthy();
      expect(screen.getByText("npm run build")).toBeTruthy();
    });
  });
});
