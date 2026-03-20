// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BulkCommandPalette, openBulkCommandPalette } from "../BulkCommandPalette";
import { usePaletteStore } from "@/store/paletteStore";

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

vi.mock("@/components/Worktree/terminalStateConfig", () => ({
  STATE_ICONS: {
    working: ({ className }: { className?: string }) =>
      `<span data-testid="state-icon-working" class="${className}">W</span>`,
    idle: ({ className }: { className?: string }) =>
      `<span data-testid="state-icon-idle" class="${className}">I</span>`,
    waiting: ({ className }: { className?: string }) =>
      `<span data-testid="state-icon-waiting" class="${className}">WA</span>`,
    completed: ({ className }: { className?: string }) =>
      `<span data-testid="state-icon-completed" class="${className}">C</span>`,
    failed: ({ className }: { className?: string }) =>
      `<span data-testid="state-icon-failed" class="${className}">F</span>`,
  },
  STATE_COLORS: {
    working: "text-state-working",
    idle: "text-canopy-text/40",
    waiting: "text-state-waiting",
    completed: "text-state-completed",
    failed: "text-state-failed",
  },
}));

vi.mock("@/utils/terminalType", () => ({
  isAgentTerminal: (kindOrType?: string, agentId?: string) => kindOrType === "agent" || !!agentId,
}));

vi.mock("p-queue", () => ({
  default: class MockPQueue {
    concurrency: number;
    constructor(opts: { concurrency: number }) {
      this.concurrency = opts.concurrency;
    }
    async addAll(fns: (() => Promise<unknown>)[]) {
      for (const fn of fns) await fn();
    }
  },
}));

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

vi.mock("@/store/worktreeDataStore", () => ({
  useWorktreeDataStore: (selector: (s: { worktrees: typeof mockWorktrees }) => unknown) =>
    selector({ worktrees: mockWorktrees }),
}));

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: Object.assign(
    (selector: (s: { terminals: typeof mockTerminals }) => unknown) =>
      selector({ terminals: mockTerminals }),
    {
      getState: () => ({ terminals: mockTerminals }),
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
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render when closed", () => {
    render(<BulkCommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders worktree rows excluding main worktree when open", () => {
    render(<BulkCommandPalette />);
    openPalette();
    expect(screen.getByText("feature/a")).toBeTruthy();
    expect(screen.getByText("feature/b")).toBeTruthy();
    expect(screen.queryByText("main")).toBeNull();
  });

  it("shows agent terminal count per worktree", () => {
    render(<BulkCommandPalette />);
    openPalette();
    expect(screen.getByText("2 agents")).toBeTruthy(); // wt-1 has 2 (t1, t2), t5 is trashed
    expect(screen.getAllByText("1 agent").length).toBeGreaterThanOrEqual(1); // wt-2 and wt-3 each have 1
  });

  it("toggles worktree selection via checkbox row click", () => {
    render(<BulkCommandPalette />);
    openPalette();
    const row = screen.getByText("feature/a").closest("button")!;
    fireEvent.click(row);
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(row);
    expect(checkbox.checked).toBe(false);
  });

  it("select all toggles all enabled rows", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Select All"));
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const enabled = checkboxes.filter((c) => !c.disabled);
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

  it("sends double-escape with 1s delay between escapes", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("feature/b").closest("button")!);
    fireEvent.click(screen.getByText("Double Escape"));
    const sendBtn = screen.getByRole("button", { name: "Send" });
    fireEvent.click(sendBtn);
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
    const input = screen.getByPlaceholderText(/Enter command to send/);
    fireEvent.change(input, { target: { value: "npm test" } });
    expect(screen.getByText("Preview")).toBeTruthy();
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText(/Back/)).toBeTruthy();
    expect(screen.getByText("feature/a")).toBeTruthy();
  });

  it("sends text command per worktree after confirm in preview", async () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    const input = screen.getByPlaceholderText(/Enter command to send/);
    fireEvent.change(input, { target: { value: "npm test" } });
    fireEvent.click(screen.getByText("Preview"));
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm"));
    });
    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(mockSubmit).toHaveBeenCalledWith("t1", "npm test");
    expect(mockSubmit).toHaveBeenCalledWith("t2", "npm test");
  });

  it("resolves template variables per worktree in preview", () => {
    render(<BulkCommandPalette />);
    openPalette();
    fireEvent.click(screen.getByText("Text Command"));
    fireEvent.click(screen.getByText("feature/a").closest("button")!);
    fireEvent.click(screen.getByText("feature/b").closest("button")!);
    const input = screen.getByPlaceholderText(/Enter command to send/);
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
    const input = screen.getByPlaceholderText(/Enter command to send/);
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
    it("renders preset buttons", () => {
      render(<BulkCommandPalette />);
      openPalette();
      expect(screen.getByText("Active")).toBeTruthy();
      expect(screen.getByText("Waiting")).toBeTruthy();
      expect(screen.getByText("Idle")).toBeTruthy();
      expect(screen.getByText("Completed")).toBeTruthy();
      expect(screen.getByText("Failed")).toBeTruthy();
    });

    it("Active preset selects worktrees with working state", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Active"));
      // wt-1 has dominant state "working" (mock returns first valid state)
      const wt1Checkbox = screen
        .getByText("feature/a")
        .closest("button")!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(wt1Checkbox.checked).toBe(true);
    });

    it("Waiting preset selects worktrees with waiting state", () => {
      render(<BulkCommandPalette />);
      openPalette();
      fireEvent.click(screen.getByText("Waiting"));
      const wt2Checkbox = screen
        .getByText("feature/b")
        .closest("button")!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(wt2Checkbox.checked).toBe(true);
    });

    it("Idle preset selects worktrees with null dominant state", () => {
      render(<BulkCommandPalette />);
      openPalette();
      // wt-3 has a single terminal with undefined agentState, so mock returns null
      fireEvent.click(screen.getByText("Idle"));
      const wt3Checkbox = screen
        .getByText("feature/c")
        .closest("button")!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(wt3Checkbox.checked).toBe(true);
    });

    it("presets are additive - do not clear existing selection", () => {
      render(<BulkCommandPalette />);
      openPalette();
      // First select wt-1 manually
      fireEvent.click(screen.getByText("feature/a").closest("button")!);
      // Then apply Waiting preset
      fireEvent.click(screen.getByText("Waiting"));
      // Both should be selected
      const wt1Checkbox = screen
        .getByText("feature/a")
        .closest("button")!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      const wt2Checkbox = screen
        .getByText("feature/b")
        .closest("button")!
        .querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(wt1Checkbox.checked).toBe(true);
      expect(wt2Checkbox.checked).toBe(true);
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
    const input = screen.getByPlaceholderText(/Enter command to send/);
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.click(screen.getByText("Preview"));
    expect(screen.getByText(/Back/)).toBeTruthy();
    // Switch mode — should reset to select step
    fireEvent.click(screen.getByText("Keystroke"));
    expect(screen.queryByText(/Back/)).toBeNull();
  });
});
