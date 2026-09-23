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

const settingsMock = vi.hoisted(() => ({
  promoteToSaved: vi.fn(),
  removeFromSaved: vi.fn(),
  allDetectedRunners: [] as Array<{ id: string; name: string; command: string }>,
  runCommands: [] as Array<{ id: string; name: string; command: string }>,
}));

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    allDetectedRunners: settingsMock.allDetectedRunners,
    settings: { runCommands: settingsMock.runCommands },
    promoteToSaved: settingsMock.promoteToSaved,
    removeFromSaved: settingsMock.removeFromSaved,
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
    worktreeMap: new Map([
      ["wt-1", { name: "main", branch: "develop", path: "/tmp/test-worktree" }],
    ]),
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

import { QuickRun, QuickRunToggle, useQuickRunExpanded } from "../QuickRun";

/** The panel as the sidebar footer mounts it: only while its toggle is open. */
function Footer({ projectId }: { projectId: string }) {
  const [open, toggle] = useQuickRunExpanded(projectId);
  return (
    <>
      {open && <QuickRun projectId={projectId} focusOnMount />}
      <QuickRunToggle expanded={open} onToggle={toggle} />
    </>
  );
}

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
    render(<Footer projectId="test-project" />);

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
    render(<Footer projectId="test-project" />);

    const input = openPanel();
    fireEvent.change(input, { target: { value: "npm test" } });

    // Enter via keyboard
    fireEvent.keyDown(input, { key: "Enter" });

    // Then click the run button before addPanel resolves
    const runButton = screen.getByLabelText("Run");
    fireEvent.click(runButton);

    expect(mockAddTerminal).toHaveBeenCalledTimes(1);

    await act(async () => resolveTerminal());
  });

  it("allows a second run after the first completes", async () => {
    setupPendingTerminal();
    render(<Footer projectId="test-project" />);

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
    render(<Footer projectId="test-project" />);

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
    render(<Footer projectId="test-project" />);

    const input = openPanel();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockAddTerminal).not.toHaveBeenCalled();
  });

  it("stays closed until asked, and remembers the answer per project", () => {
    const { unmount } = render(<Footer projectId="test-project" />);

    // Closed is the resting state: this launcher is opt-in, and it used to
    // spend the footer's vertical budget on every session that never ran a
    // command.
    expect(screen.queryByPlaceholderText("Run a command")).toBeNull();

    openPanel();
    expect(screen.queryByPlaceholderText("Run a command")).not.toBeNull();
    unmount();

    // Reopening the same project honours the choice...
    const again = render(<Footer projectId="test-project" />);
    expect(screen.queryByPlaceholderText("Run a command")).not.toBeNull();
    again.unmount();

    // ...while a different project starts from the default again.
    render(<Footer projectId="other-project" />);
    expect(screen.queryByPlaceholderText("Run a command")).toBeNull();
  });

  it("keeps one name on its toggle and reports open or shut through aria-expanded", () => {
    render(<Footer projectId="test-project" />);
    const toggle = screen.getByRole("button", { name: /run command/i });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    openPanel();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Run command");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
  });

  it("lands in the field when opened, without throwing the suggestion list over the panel", () => {
    localStorage.setItem(
      "daintree_cmd_history_test-project",
      JSON.stringify([{ command: "npm test", timestamp: 1 }])
    );
    render(<Footer projectId="test-project" />);
    const input = openPanel();

    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("false");

    // Asking for the list still opens it.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("dismisses suggestions on Escape without leaving the field", () => {
    localStorage.setItem(
      "daintree_cmd_history_test-project",
      JSON.stringify([{ command: "npm test", timestamp: 1 }])
    );
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(input);
  });

  it("captions the destination with the branch, not the worktree's folder name", () => {
    render(<Footer projectId="test-project" />);
    openPanel();

    const panel = document.getElementById("quick-run-panel")!;
    expect(panel.textContent).toContain("develop");
    expect(panel.textContent).not.toContain("main");
  });

  it("keeps the arrow-key selection scrolled into view", () => {
    localStorage.setItem(
      "daintree_cmd_history_test-project",
      JSON.stringify([
        { command: "npm test", timestamp: 2 },
        { command: "npm run lint", timestamp: 1 },
      ])
    );
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });

      // Whatever row the combobox names as active is the row brought into view.
      expect(scrolled.at(-1)).toBe(input.getAttribute("aria-activedescendant"));
      expect(scrolled.length).toBeGreaterThanOrEqual(2);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  function seedHistory(...commands: string[]) {
    localStorage.setItem(
      "daintree_cmd_history_test-project",
      JSON.stringify(commands.map((command, i) => ({ command, timestamp: commands.length - i })))
    );
  }

  it("puts nothing interactive inside an option", () => {
    // An option's children are presentational to assistive technology, so a
    // pin button nested in one is unreachable there — and a button inside the
    // button the option used to be was invalid HTML besides.
    settingsMock.allDetectedRunners = [{ id: "r", name: "test", command: "npm test" }];
    settingsMock.runCommands = [{ id: "s", name: "Dev", command: "npm run dev" }];
    seedHistory("ls -la");
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      const options = screen.getAllByRole("option");
      expect(options.length).toBe(3);
      for (const option of options) {
        expect(option.querySelector("button, a[href], input, [tabindex]")).toBeNull();
      }
    } finally {
      settingsMock.allDetectedRunners = [];
      settingsMock.runCommands = [];
    }
  });

  it("files every suggestion under a labelled band", () => {
    settingsMock.allDetectedRunners = [{ id: "r", name: "test", command: "npm test" }];
    settingsMock.runCommands = [{ id: "s", name: "Dev", command: "npm run dev" }];
    seedHistory("ls -la");
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      const labels = new Set<string>();
      for (const option of screen.getAllByRole("option")) {
        const group = option.closest('[role="group"]');
        expect(group).not.toBeNull();
        const label = document.getElementById(group!.getAttribute("aria-labelledby")!);
        expect(label?.textContent?.trim()).toBeTruthy();
        // The band label is never itself a row the arrows can land on.
        expect(label?.getAttribute("role")).not.toBe("option");
        labels.add(label!.textContent!);
      }
      expect(labels.size).toBe(3);
    } finally {
      settingsMock.allDetectedRunners = [];
      settingsMock.runCommands = [];
    }
  });

  it("shows the typed command as the row Enter runs, and runs it literally", () => {
    seedHistory("npm test", "npm run lint");
    mockAddTerminal.mockResolvedValue(undefined);
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.change(input, { target: { value: "npm t" } });

    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(active?.textContent).toContain("npm t");
    expect(active).toBe(screen.getAllByRole("option")[0]);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: "npm t" }));
  });

  it("runs the same command from the arrow as from Enter", () => {
    seedHistory("npm test", "npm run lint");
    mockAddTerminal.mockResolvedValue(undefined);
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.change(input, { target: { value: "npm" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    const expected = active!.getAttribute("title")!;
    expect(expected).not.toBe("npm");

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: expected }));
  });

  it("gives the command back when it fails to start", async () => {
    mockAddTerminal.mockRejectedValue(new Error("spawn failed"));
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.change(input, { target: { value: "cargo run" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByDisplayValue("cargo run")).toBe(input);
    expect(screen.getByRole("alert").textContent).toContain("cargo run");
  });

  it("pins the highlighted row from the keyboard without leaving the field", () => {
    seedHistory("docker compose up");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "π", code: "KeyP", altKey: true });
    expect(settingsMock.promoteToSaved).toHaveBeenCalledWith(
      expect.objectContaining({ command: "docker compose up" })
    );
    expect(document.activeElement).toBe(input);
  });

  it("renders all main buttons with type='button'", () => {
    render(<Footer projectId="test-project" />);
    openPanel();

    const allButtons = screen.getAllByRole("button");
    for (const button of allButtons) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });
});
