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

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: (
    selector: (s: {
      addTerminal: typeof mockAddTerminal;
      terminalsById: Record<string, never>;
      terminalIds: never[];
    }) => unknown
  ) => selector({ addTerminal: mockAddTerminal, terminalsById: {}, terminalIds: [] }),
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
  });

  function typeAndEnter(text: string) {
    const input = screen.getByPlaceholderText("Execute command...");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("prevents duplicate terminal spawn on rapid double Enter", async () => {
    setupPendingTerminal();
    render(<QuickRun projectId="test-project" />);

    const input = screen.getByPlaceholderText("Execute command...");
    fireEvent.change(input, { target: { value: "npm test" } });

    // Fire Enter twice before the first addTerminal resolves
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddTerminal).toHaveBeenCalledTimes(1);

    // Resolve and clean up
    await act(async () => resolveTerminal());
  });

  it("prevents duplicate spawn from Enter + run button click", async () => {
    setupPendingTerminal();
    render(<QuickRun projectId="test-project" />);

    const input = screen.getByPlaceholderText("Execute command...");
    fireEvent.change(input, { target: { value: "npm test" } });

    // Enter via keyboard
    fireEvent.keyDown(input, { key: "Enter" });

    // Then click the run button before addTerminal resolves
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

  it("releases the guard when addTerminal throws", async () => {
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

  it("does not call addTerminal for blank input", () => {
    render(<QuickRun projectId="test-project" />);

    const input = screen.getByPlaceholderText("Execute command...");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddTerminal).not.toHaveBeenCalled();
  });

  it("renders all main buttons with type='button'", () => {
    render(<QuickRun projectId="test-project" />);

    const allButtons = screen.getAllByRole("button");
    for (const button of allButtons) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });
});
