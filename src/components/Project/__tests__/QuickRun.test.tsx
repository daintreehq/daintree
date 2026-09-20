/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Provide localStorage stub for jsdom
const storageMap = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => storageMap.set(key, value),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  },
  configurable: true,
});

const mockAddTerminal = vi.fn();
let addTerminalResolver: (() => void) | null = null;
let addTerminalRejecter: ((err: Error) => void) | null = null;

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    allDetectedRunners: [],
    settings: { runCommands: [] },
    promoteToSaved: vi.fn(),
    removeFromSaved: vi.fn(),
  }),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (
    selector: (s: {
      addPanel: typeof mockAddTerminal;
      panelsById: Record<string, never>;
      panelIds: never[];
    }) => unknown
  ) => selector({ addPanel: mockAddTerminal, panelsById: {}, panelIds: [] }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string }) => unknown) =>
    selector({ activeWorktreeId: "wt-1" }),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    worktreeMap: new Map([["wt-1", { name: "main", path: "/tmp/test-worktree" }]]),
  }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/utils/terminalType", () => ({
  detectTerminalTypeFromCommand: () => "terminal",
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Project/RunningTaskList", () => ({
  RunningTaskList: () => null,
}));

import { QuickRun } from "../QuickRun";

function setupPendingTerminal() {
  const promise = new Promise<void>((resolve, reject) => {
    addTerminalResolver = resolve;
    addTerminalRejecter = reject;
  });
  mockAddTerminal.mockReturnValue(promise);
}

function resolveTerminal() {
  addTerminalResolver?.();
  addTerminalResolver = null;
}

function rejectTerminal(err: Error) {
  addTerminalRejecter?.(err);
  addTerminalRejecter = null;
}

describe("QuickRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addTerminalResolver = null;
    addTerminalRejecter = null;
    // The disclosure persists per project, so one test opening the panel would
    // otherwise hand the next test an already-open one.
    localStorage.clear();
  });

  /**
   * The panel is collapsed by default now, so every test that needs the input
   * opens it first. These tests are about the spawn guard, not the disclosure.
   */
  function openPanel() {
    if (screen.queryByPlaceholderText("Run a command") === null) {
      fireEvent.click(screen.getByRole("button", { name: /run command/i }));
    }
    return screen.getByPlaceholderText("Run a command");
  }

  function typeAndEnter(text: string) {
    const input = openPanel();
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("prevents duplicate terminal spawn on rapid double Enter", async () => {
    setupPendingTerminal();
    render(<QuickRun projectId="test-project" />);

    const input = openPanel();
    fireEvent.change(input, { target: { value: "npm test" } });

    // Fire Enter twice before the first addPanel resolves
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddTerminal).toHaveBeenCalledTimes(1);

    // Resolve and clean up
    await act(async () => resolveTerminal());
  });

  it("prevents duplicate spawn from Enter + run button click", async () => {
    setupPendingTerminal();
    render(<QuickRun projectId="test-project" />);

    const input = openPanel();
    fireEvent.change(input, { target: { value: "npm test" } });

    // Enter via keyboard
    fireEvent.keyDown(input, { key: "Enter" });

    // Then click the run button before addPanel resolves
    const runButton = screen.getByLabelText("Run command");
    fireEvent.click(runButton);

    expect(mockAddTerminal).toHaveBeenCalledTimes(1);

    await act(async () => resolveTerminal());
  });

  it("allows a second run after the first completes", async () => {
    setupPendingTerminal();
    render(<QuickRun projectId="test-project" />);

    typeAndEnter("npm test");
    expect(mockAddTerminal).toHaveBeenCalledTimes(1);

    // Resolve first run
    await act(async () => resolveTerminal());

    // Set up a new pending terminal for the second run
    setupPendingTerminal();

    // Second run should work
    typeAndEnter("npm start");
    expect(mockAddTerminal).toHaveBeenCalledTimes(2);

    await act(async () => resolveTerminal());
  });

  it("releases the guard when addPanel throws", async () => {
    setupPendingTerminal();
    render(<QuickRun projectId="test-project" />);

    typeAndEnter("npm test");
    expect(mockAddTerminal).toHaveBeenCalledTimes(1);

    // Reject first run
    await act(async () => rejectTerminal(new Error("spawn failed")));

    // Set up new terminal for retry
    setupPendingTerminal();

    // Should be able to run again after error
    typeAndEnter("npm test");
    expect(mockAddTerminal).toHaveBeenCalledTimes(2);

    await act(async () => resolveTerminal());
  });

  it("does not call addPanel for blank input", () => {
    render(<QuickRun projectId="test-project" />);

    const input = openPanel();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddTerminal).not.toHaveBeenCalled();
  });

  it("stays closed until asked, and remembers the answer per project", () => {
    const { unmount } = render(<QuickRun projectId="test-project" />);

    // Closed is the resting state: this launcher is opt-in, and it used to
    // spend the footer's vertical budget on every session that never ran a
    // command.
    expect(screen.queryByPlaceholderText("Run a command")).toBeNull();

    openPanel();
    expect(screen.queryByPlaceholderText("Run a command")).not.toBeNull();
    unmount();

    // Reopening the same project honours the choice...
    const again = render(<QuickRun projectId="test-project" />);
    expect(screen.queryByPlaceholderText("Run a command")).not.toBeNull();
    again.unmount();

    // ...while a different project starts from the default again.
    render(<QuickRun projectId="other-project" />);
    expect(screen.queryByPlaceholderText("Run a command")).toBeNull();
  });

  it("renders all main buttons with type='button'", () => {
    render(<QuickRun projectId="test-project" />);
    openPanel();

    const allButtons = screen.getAllByRole("button");
    for (const button of allButtons) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });
});
