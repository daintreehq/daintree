import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { stripAnsiCodes } from "@shared/utils/artifactParser";

// Mock window.electron and window event listeners before any imports
const mockGetSerializedState = vi.fn();
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();
const mockDispatchEvent = vi.fn();

type TerminalOutputResult = {
  terminalId: string;
  content: string | null;
  lineCount: number;
  truncated: boolean;
  error?: string;
};

beforeAll(() => {
  // Provide a complete window mock before module imports
  vi.stubGlobal("window", {
    electron: {
      terminal: {
        getSerializedState: mockGetSerializedState,
      },
    },
    addEventListener: mockAddEventListener,
    removeEventListener: mockRemoveEventListener,
    dispatchEvent: mockDispatchEvent,
    location: {
      origin: "http://localhost:5173",
      protocol: "http:",
      href: "http://localhost:5173/",
    },
    top: null, // Will be set to self
  });
  // Make window.top reference itself
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).top = window;
});

// Helper to create the action registry
async function createRegistry() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).self = globalThis;

  // Reset module cache to ensure fresh imports with mocks
  vi.resetModules();

  const { createActionDefinitions } = await import("../actionDefinitions");
  return createActionDefinitions({
    onOpenSettings: () => {},
    onOpenSettingsTab: () => {},
    onToggleSidebar: () => {},
    onToggleFocusMode: () => {},
    onOpenAgentPalette: () => {},
    onOpenActionPalette: () => {},
    onOpenQuickSwitcher: () => {},
    onOpenWorktreePalette: () => {},
    onToggleWorktreeOverview: () => {},
    onOpenWorktreeOverview: () => {},
    onCloseWorktreeOverview: () => {},
    onOpenNewTerminalPalette: () => {},
    onOpenPanelPalette: () => {},
    onOpenProjectSwitcherPalette: () => {},
    onOpenShortcuts: () => {},
    onLaunchAgent: async () => null,
    onInject: () => {},
    getDefaultCwd: () => "/",
    getActiveWorktreeId: () => undefined,
    getWorktrees: () => [],
    getFocusedId: () => null,
    getGridNavigation: () => ({
      findNearest: () => null,
      findByIndex: () => null,
      findDockByIndex: () => null,
      getCurrentLocation: () => null,
    }),
  });
}

describe("terminal.getOutput action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is registered in the action registry", async () => {
    const actions = await createRegistry();
    expect(actions.has("terminal.getOutput")).toBe(true);
  });

  it("has correct metadata", async () => {
    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    expect(actionFn).toBeDefined();

    const action = actionFn!();
    expect(action.id).toBe("terminal.getOutput");
    expect(action.kind).toBe("query");
    expect(action.danger).toBe("safe");
    expect(action.category).toBe("terminal");
  });

  it("returns last N lines from terminal buffer", async () => {
    const mockBuffer = "line1\nline2\nline3\nline4\nline5";
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run(
      { terminalId: "test-terminal", maxLines: 3 },
      {}
    )) as TerminalOutputResult;

    expect(result.terminalId).toBe("test-terminal");
    expect(result.content).toBe("line3\nline4\nline5");
    expect(result.lineCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("returns all lines when buffer has fewer than maxLines", async () => {
    const mockBuffer = "line1\nline2\nline3";
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run(
      { terminalId: "test-terminal", maxLines: 100 },
      {}
    )) as TerminalOutputResult;

    expect(result.content).toBe("line1\nline2\nline3");
    expect(result.lineCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("defaults to 100 lines when maxLines not specified", async () => {
    // Generate 150 lines
    const lines = Array.from({ length: 150 }, (_, i) => `line${i + 1}`);
    const mockBuffer = lines.join("\n");
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run({ terminalId: "test-terminal" }, {})) as TerminalOutputResult;

    expect(result.lineCount).toBe(100);
    expect(result.truncated).toBe(true);
    // Should have last 100 lines (line51-line150)
    expect(result.content).toContain("line51");
    expect(result.content).toContain("line150");
  });

  it("strips ANSI codes by default", async () => {
    const mockBuffer = "\x1b[32mgreen text\x1b[0m\n\x1b[31mred text\x1b[0m";
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run({ terminalId: "test-terminal" }, {})) as TerminalOutputResult;

    expect(result.content).toBe("green text\nred text");
    expect(result.content).not.toContain("\x1b");
  });

  it("preserves ANSI codes when stripAnsi is false", async () => {
    const mockBuffer = "\x1b[32mgreen text\x1b[0m";
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run(
      { terminalId: "test-terminal", stripAnsi: false },
      {}
    )) as TerminalOutputResult;

    expect(result.content).toBe("\x1b[32mgreen text\x1b[0m");
    expect(result.content).toContain("\x1b");
  });

  it("returns null content for non-existent terminal", async () => {
    mockGetSerializedState.mockResolvedValue(null);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run({ terminalId: "non-existent" }, {})) as TerminalOutputResult;

    expect(result.terminalId).toBe("non-existent");
    expect(result.content).toBeNull();
    expect(result.lineCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("handles empty terminal buffer", async () => {
    mockGetSerializedState.mockResolvedValue("");

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run({ terminalId: "empty-terminal" }, {})) as TerminalOutputResult;

    expect(result.content).toBe("");
    expect(result.lineCount).toBe(1); // Empty string splits into one empty line
    expect(result.truncated).toBe(false);
  });

  it("enforces maxLines upper bound of 1000", async () => {
    // Generate 1500 lines
    const lines = Array.from({ length: 1500 }, (_, i) => `line${i + 1}`);
    const mockBuffer = lines.join("\n");
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run(
      { terminalId: "test-terminal", maxLines: 5000 },
      {}
    )) as TerminalOutputResult;

    // Should cap at 1000 lines
    expect(result.lineCount).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it("enforces maxLines lower bound of 1", async () => {
    const mockBuffer = "line1\nline2\nline3";
    mockGetSerializedState.mockResolvedValue(mockBuffer);

    const actions = await createRegistry();
    const actionFn = actions.get("terminal.getOutput");
    const action = actionFn!();

    const result = (await action.run(
      { terminalId: "test-terminal", maxLines: 0 },
      {}
    )) as TerminalOutputResult;

    // Should get at least 1 line
    expect(result.lineCount).toBe(1);
  });
});

describe("stripAnsiCodes utility", () => {
  it("strips common color codes", () => {
    const input = "\x1b[32mgreen\x1b[0m \x1b[31mred\x1b[0m";
    expect(stripAnsiCodes(input)).toBe("green red");
  });

  it("strips cursor positioning codes", () => {
    const input = "\x1b[2Jcleared\x1b[H";
    expect(stripAnsiCodes(input)).toBe("cleared");
  });

  it("handles text with no ANSI codes", () => {
    const input = "plain text";
    expect(stripAnsiCodes(input)).toBe("plain text");
  });
});
