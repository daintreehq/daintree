/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Component, StrictMode, type ReactNode } from "react";
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
  runCommands: [] as Array<{
    id: string;
    name: string;
    command: string;
    preferredLocation?: "dock" | "grid";
  }>,
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

const taskListProps = vi.hoisted(() => ({
  current: null as null | { onFocusFallback?: (options: FocusOptions) => void },
}));

vi.mock("@/components/Project/RunningTaskList", () => ({
  RunningTaskList: (props: { onFocusFallback?: (options: FocusOptions) => void }) => {
    taskListProps.current = props;
    return null;
  },
}));

import { QuickRun } from "../QuickRun";
import { resetQuickRunHistoryForTests } from "../quickRunHistory";
import { setPermanentFallbackHandler } from "@/store/persistence/safeStorage";
import { QuickRunToggle, useQuickRunExpanded } from "../QuickRunToggle";

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
    resetQuickRunHistoryForTests();
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

  it("wraps the arrows through the field and jumps with Home and End while the list shows", () => {
    seedHistory("npm test", "npm run lint", "ls -la");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    const lit = () => {
      const id = input.getAttribute("aria-activedescendant");
      return id ? document.getElementById(id) : null;
    };

    // Home and End keep the caret while the list is shut.
    expect(fireEvent.keyDown(input, { key: "End" })).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const rows = commandOptions();
    expect(rows.length).toBe(3);
    expect(lit()).toBe(rows[0]);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(lit()).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(lit()).toBe(rows[2]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(lit()).toBeNull();

    fireEvent.keyDown(input, { key: "End" });
    expect(lit()).toBe(rows[2]);
    fireEvent.keyDown(input, { key: "Home" });
    expect(lit()).toBe(rows[0]);
  });

  it("leaves End to the IME mid-composition while the list shows", () => {
    seedHistory("npm test", "npm run lint", "ls -la");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const rows = commandOptions();
    const lit = () => document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
    expect(lit()).toBe(rows[0]);

    expect(fireEvent.keyDown(input, { key: "End", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "End", keyCode: 229 })).toBe(true);
    expect(lit()).toBe(rows[0]);
  });

  it("leaves Enter, Tab and Escape to the IME mid-composition, then runs on a plain Enter", async () => {
    seedHistory("npm test");
    render(<Footer projectId="test-project" />);
    const input = openPanel() as HTMLInputElement;
    fireEvent.change(input, { target: { value: "np" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const key of ["Enter", "Tab", "Escape"]) {
        expect(fireEvent.keyDown(input, { key, ...init })).toBe(true);
      }
    }
    expect(mockAddTerminal).not.toHaveBeenCalled();
    expect(input.value).toBe("np");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(mockAddTerminal).toHaveBeenCalledTimes(1);
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

  it("claims Escape only when it shuts the suggestions", () => {
    localStorage.setItem(
      "daintree_cmd_history_test-project",
      JSON.stringify([{ command: "npm test", timestamp: 1 }])
    );
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // fireEvent returns false once a handler prevented the default.
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(true);
  });

  it("claims Escape from a toggle only when it shuts the suggestions", () => {
    localStorage.setItem(
      "daintree_cmd_history_test-project",
      JSON.stringify([{ command: "npm test", timestamp: 1 }])
    );
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const toggle = screen.getByRole("button", { name: "Auto-restart" });

    expect(fireEvent.keyDown(toggle, { key: "Escape" })).toBe(false);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(fireEvent.keyDown(toggle, { key: "Escape" })).toBe(true);
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

  /** The rows that run something — not the disabled band headers. */
  function commandOptions() {
    return screen.getAllByRole("option").filter((o) => o.getAttribute("aria-disabled") !== "true");
  }

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
      const options = commandOptions();
      expect(options.length).toBe(3);
      for (const option of options) {
        expect(option.querySelector("button, a[href], input, [tabindex]")).toBeNull();
      }
    } finally {
      settingsMock.allDetectedRunners = [];
      settingsMock.runCommands = [];
    }
  });

  it("files every suggestion under a named band the arrows never land on", () => {
    // Bands are disabled options, not role="group" labels: those are dropped
    // under Chromium + VoiceOver (the action palette's precedent).
    settingsMock.allDetectedRunners = [{ id: "r", name: "test", command: "npm test" }];
    settingsMock.runCommands = [{ id: "s", name: "Dev", command: "npm run dev" }];
    seedHistory("ls -la");
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      const all = screen.getAllByRole("option");
      const bands = new Set<string>();
      for (const option of commandOptions()) {
        const before = all.slice(0, all.indexOf(option)).reverse();
        const band = before.find((o) => o.getAttribute("aria-disabled") === "true");
        expect(band?.getAttribute("aria-label")).toBeTruthy();
        bands.add(band!.getAttribute("aria-label")!);
      }
      expect(bands.size).toBe(3);

      // Walking every row with the arrows never lights a band. A lap passes
      // through the field itself once, where nothing is lit.
      let atField = 0;
      for (let i = 0; i < commandOptions().length + 1; i++) {
        fireEvent.keyDown(input, { key: "ArrowDown" });
        const activeId = input.getAttribute("aria-activedescendant");
        if (activeId === null) {
          atField++;
          continue;
        }
        expect(document.getElementById(activeId)?.getAttribute("aria-disabled")).toBeNull();
      }
      expect(atField).toBe(1);
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
    expect(active).toBe(commandOptions()[0]);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: "npm t" }));
  });

  it("lights an exact match where it sits, under its own band", () => {
    settingsMock.runCommands = [{ id: "s", name: "Dev", command: "npm run dev" }];
    seedHistory("npm run dev -- --host");
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.change(input, { target: { value: "npm run dev" } });

      const active = document.getElementById(input.getAttribute("aria-activedescendant")!)!;
      expect(active.getAttribute("data-command")).toBe("npm run dev");
      const all = screen.getAllByRole("option");
      const band = all
        .slice(0, all.indexOf(active))
        .reverse()
        .find((o) => o.getAttribute("aria-disabled") === "true");
      expect(band?.getAttribute("aria-label")).toBe("Pinned");
      // No second "Run npm run dev" row competing with the pinned one.
      expect(
        screen
          .getAllByRole("option")
          .filter((o) => o.getAttribute("data-command") === "npm run dev")
      ).toHaveLength(1);
    } finally {
      settingsMock.runCommands = [];
    }
  });

  describe("commands that differ only in quoting or in whitespace inside quotes", () => {
    // Pairs a shell reads differently, each of which the old folding made one command.
    const PAIRS: Array<[string, string]> = [
      ["'$SHELL'", "$SHELL"],
      ["echo '$HOME'", 'echo "$HOME"'],
      ["rm '*.log'", "rm *.log"],
      ["printf 'a  b'", "printf 'a b'"],
    ];

    it("runs what was typed, not a quoted history row that looks the same once quotes are dropped", () => {
      seedHistory("'$SHELL'");
      mockAddTerminal.mockResolvedValue(undefined);
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.change(input, { target: { value: "$SHELL" } });

      const [typed, quoted] = commandOptions();
      expect(typed!.getAttribute("data-command")).toBe("$SHELL");
      expect(typed!.textContent).toMatch(/^Run/);
      expect(quoted!.getAttribute("data-command")).toBe("'$SHELL'");
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(typed);

      fireEvent.keyDown(input, { key: "Enter" });
      expect(mockAddTerminal).toHaveBeenCalledTimes(1);
      expect(mockAddTerminal).toHaveBeenCalledWith(expect.objectContaining({ command: "$SHELL" }));
    });

    it("runs the quoted command when it is the typed one, even with the unquoted spelling in history", () => {
      seedHistory("$SHELL");
      mockAddTerminal.mockResolvedValue(undefined);
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.change(input, { target: { value: "'$SHELL'" } });

      expect(commandOptions()[0]!.getAttribute("data-command")).toBe("'$SHELL'");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(mockAddTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ command: "'$SHELL'" })
      );
    });

    it("completes a row that differs from the typed text only by its quotes", () => {
      seedHistory("'$SHELL'");
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.change(input, { target: { value: "$SHELL" } });
      fireEvent.keyDown(input, { key: "ArrowDown" });

      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(
        commandOptions()[1]
      );
      expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
      expect((input as HTMLInputElement).value).toBe("'$SHELL'");
      expect(mockAddTerminal).not.toHaveBeenCalled();
    });

    it.each(PAIRS)("keeps %s and %s as two suggestions", (first, second) => {
      seedHistory(first, second);
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });

      expect(commandOptions().map((o) => o.getAttribute("data-command"))).toEqual([first, second]);
    });

    it.each(PAIRS)("leaves both %s and %s recallable once each has run", async (first, second) => {
      mockAddTerminal.mockResolvedValue(undefined);
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      for (const command of [first, second]) {
        fireEvent.change(input, { target: { value: command } });
        await act(async () => {
          fireEvent.keyDown(input, { key: "Enter" });
        });
      }
      expect(mockAddTerminal).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(commandOptions().map((o) => o.getAttribute("data-command"))).toEqual([second, first]);
    });

    it.each([
      [
        "a pinned command",
        () => {
          settingsMock.runCommands = [{ id: "s", name: "Shell", command: "'$SHELL'" }];
        },
      ],
      [
        "a detected script",
        () => {
          settingsMock.allDetectedRunners = [{ id: "r", name: "shell", command: "'$SHELL'" }];
        },
      ],
    ])(
      "runs what was typed, not %s that looks the same once quotes are dropped",
      (_source, arrange) => {
        arrange();
        mockAddTerminal.mockResolvedValue(undefined);
        try {
          render(<Footer projectId="test-project" />);
          const input = openPanel();
          fireEvent.change(input, { target: { value: "$SHELL" } });

          expect(commandOptions().map((o) => o.getAttribute("data-command"))).toEqual([
            "$SHELL",
            "'$SHELL'",
          ]);
          fireEvent.click(screen.getByRole("button", { name: "Run" }));
          expect(mockAddTerminal).toHaveBeenCalledWith(
            expect.objectContaining({ command: "$SHELL" })
          );
        } finally {
          settingsMock.allDetectedRunners = [];
          settingsMock.runCommands = [];
        }
      }
    );

    it("keeps a pin written with quotes apart from the detected script, and unpins the text it was saved as", () => {
      settingsMock.runCommands = [{ id: "s", name: "Tests", command: 'npm run "test"' }];
      settingsMock.allDetectedRunners = [{ id: "r", name: "test", command: "npm run test" }];
      try {
        render(<Footer projectId="test-project" />);
        const input = openPanel();
        fireEvent.keyDown(input, { key: "ArrowDown" });

        expect(commandOptions().map((o) => o.getAttribute("data-command"))).toEqual([
          'npm run "test"',
          "npm run test",
        ]);
        fireEvent.keyDown(input, { key: "π", code: "KeyP", altKey: true });
        expect(settingsMock.removeFromSaved).toHaveBeenCalledWith('npm run "test"');
      } finally {
        settingsMock.allDetectedRunners = [];
        settingsMock.runCommands = [];
        settingsMock.removeFromSaved.mockReset();
      }
    });

    it("still shows a pin and the detected script it matches as one pinned row", () => {
      settingsMock.runCommands = [{ id: "s", name: "Tests", command: "npm run test" }];
      settingsMock.allDetectedRunners = [{ id: "r", name: "test", command: "npm run test" }];
      try {
        render(<Footer projectId="test-project" />);
        const input = openPanel();
        fireEvent.keyDown(input, { key: "ArrowDown" });

        expect(commandOptions().map((o) => o.getAttribute("data-command"))).toEqual([
          "npm run test",
        ]);
      } finally {
        settingsMock.allDetectedRunners = [];
        settingsMock.runCommands = [];
      }
    });

    it("keeps a pinned command apart from a history entry that differs only by quoting", () => {
      settingsMock.runCommands = [{ id: "s", name: "Wipe", command: "rm *.log" }];
      seedHistory("rm '*.log'");
      try {
        render(<Footer projectId="test-project" />);
        const input = openPanel();
        fireEvent.keyDown(input, { key: "ArrowDown" });

        expect(commandOptions().map((o) => o.getAttribute("data-command"))).toEqual([
          "rm *.log",
          "rm '*.log'",
        ]);
      } finally {
        settingsMock.runCommands = [];
      }
    });
  });

  it("describes the lit row with what running it will do", () => {
    settingsMock.runCommands = [
      { id: "s", name: "Docs", command: "npx serve docs", preferredLocation: "dock" },
    ];
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      const active = document.getElementById(input.getAttribute("aria-activedescendant")!)!;
      const summary = document.getElementById(active.getAttribute("aria-describedby")!)!;
      expect(summary.getAttribute("aria-hidden")).toBeNull();
      expect(summary.textContent).toContain("npx serve docs");
      expect(summary.textContent).toContain("develop");
      // The pinned command's own output choice, not the untouched grid toggle.
      expect(summary.textContent).toContain("Dock");
    } finally {
      settingsMock.runCommands = [];
    }
  });

  it("completes the lit command into the field on Tab without running it", () => {
    seedHistory("npm test -- src/components/Project/__tests__/QuickRun.test.tsx");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const tab = fireEvent.keyDown(input, { key: "Tab" });
    expect(tab).toBe(false); // default prevented: focus stays for editing
    expect(screen.getByDisplayValue(/QuickRun\.test\.tsx$/)).toBe(input);
    expect(mockAddTerminal).not.toHaveBeenCalled();

    // With the field already holding the lit command, Tab moves on as usual.
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  });

  it("shows a pinned command's own settings on the toggles, and overrides them for one launch", () => {
    settingsMock.runCommands = [
      { id: "s", name: "Docs", command: "npx serve docs", preferredLocation: "dock" },
    ];
    mockAddTerminal.mockResolvedValue(undefined);
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      const dockToggle = screen.getByRole("button", { name: /run in the dock/i });
      expect(dockToggle.getAttribute("aria-pressed")).toBe("false");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(dockToggle.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(dockToggle);
      expect(dockToggle.getAttribute("aria-pressed")).toBe("false");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(mockAddTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ command: "npx serve docs", location: "grid" })
      );
      // The saved command itself was not rewritten.
      expect(settingsMock.promoteToSaved).not.toHaveBeenCalled();
    } finally {
      settingsMock.runCommands = [];
    }
  });

  it("keeps a pinned command's settings while focus moves to the toggles", () => {
    settingsMock.runCommands = [
      { id: "s", name: "Docs", command: "npx serve docs", preferredLocation: "dock" },
    ];
    mockAddTerminal.mockResolvedValue(undefined);
    try {
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.change(input, { target: { value: "npx serve docs" } });
      const dockToggle = screen.getByRole("button", { name: /run in the dock/i });
      expect(dockToggle.getAttribute("aria-pressed")).toBe("true");

      // Tab from the field to the toggle: a real focus move, not a click.
      fireEvent.focusOut(input, { relatedTarget: dockToggle });
      dockToggle.focus();
      expect(dockToggle.getAttribute("aria-pressed")).toBe("true");
      expect(input.getAttribute("aria-expanded")).toBe("true");

      // Pressing it from the keyboard overrides this launch, not the default.
      fireEvent.click(dockToggle);
      expect(dockToggle.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(mockAddTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ command: "npx serve docs", location: "grid" })
      );
    } finally {
      settingsMock.runCommands = [];
    }
  });

  it("closes the list once focus leaves the field and its controls", () => {
    seedHistory("ls -la");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.focusOut(input, { relatedTarget: document.body });
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the summary the same height whether or not a row is lit", () => {
    // The popup is bottom-anchored, so a summary that grew as a row lit up
    // moved every row out from under the pointer between hover and click.
    seedHistory("npm test -- a/very/long/path/that/would/wrap/at/two/hundred/pixels", "ls");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.click(input);
    const summary = document.getElementById("quick-run-summary")!;
    const lines = () =>
      Array.from(summary.children).filter((c) => !c.classList.contains("sr-only")).length;
    const unlit = lines();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    expect(lines()).toBe(unlit);
  });

  it("takes focus back into the field, quietly, when the last task is dismissed", () => {
    seedHistory("ls -la");
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    input.blur();
    expect(document.activeElement).not.toBe(input);

    act(() => taskListProps.current!.onFocusFallback!({ preventScroll: true }));
    expect(document.activeElement).toBe(input);
    // Landing here after clearing a task must not throw the list over the panel.
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("brings a lit row back into view when the list reopens", () => {
    seedHistory("a", "b", "c");
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
      const lit = input.getAttribute("aria-activedescendant")!;
      fireEvent.blur(input);
      scrolled.length = 0;
      fireEvent.click(input);
      expect(input.getAttribute("aria-activedescendant")).toBe(lit);
      expect(scrolled).toContain(lit);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("runs the same command from the arrow as from Enter", () => {
    seedHistory("npm test", "npm run lint");
    mockAddTerminal.mockResolvedValue(undefined);
    render(<Footer projectId="test-project" />);
    const input = openPanel();
    fireEvent.change(input, { target: { value: "npm" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    const expected = active!.getAttribute("data-command")!;
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

  describe("when a pin or unpin does not save", () => {
    const pinKey = { key: "π", code: "KeyP", altKey: true };

    afterEach(() => {
      settingsMock.runCommands = [];
      settingsMock.promoteToSaved.mockReset();
      settingsMock.removeFromSaved.mockReset();
    });

    it("says the pin did not save, and Retry pins it again from the message", async () => {
      seedHistory("docker compose up");
      settingsMock.promoteToSaved.mockRejectedValueOnce(new Error("disk full"));
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        fireEvent.keyDown(input, pinKey);
      });

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Couldn't pin");
      expect(alert.textContent).toContain("docker compose up");
      // The row is still where it was, still lit, and the field still has focus.
      const [row] = commandOptions();
      expect(row!.getAttribute("data-command")).toBe("docker compose up");
      expect(input.getAttribute("aria-activedescendant")).toBe(row!.id);
      expect(document.activeElement).toBe(input);

      // A keyboard user activating Retry loses it when the message goes, so
      // focus has to be handed back to the field before that.
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry.getAttribute("aria-describedby")).toBe(alert.id);
      retry.focus();
      await act(async () => {
        fireEvent.click(retry);
      });
      expect(settingsMock.promoteToSaved).toHaveBeenCalledTimes(2);
      expect(settingsMock.promoteToSaved).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "docker compose up" })
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(input);
    });

    it("says the unpin did not save, and Retry unpins it again", async () => {
      settingsMock.runCommands = [{ id: "s", name: "Docs", command: "npx serve docs" }];
      settingsMock.removeFromSaved.mockRejectedValueOnce(new Error("host dropped"));
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        fireEvent.keyDown(input, pinKey);
      });

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Couldn't unpin");
      expect(alert.textContent).toContain("npx serve docs");
      // The row stays lit in the list, ready for another go.
      const [row] = commandOptions();
      expect(row!.getAttribute("data-command")).toBe("npx serve docs");
      expect(input.getAttribute("aria-activedescendant")).toBe(row!.id);
      expect(input.getAttribute("aria-expanded")).toBe("true");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      expect(settingsMock.removeFromSaved).toHaveBeenCalledTimes(2);
      expect(settingsMock.removeFromSaved).toHaveBeenLastCalledWith("npx serve docs");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("retries the command that failed, not the row lit since", async () => {
      seedHistory("docker compose up", "npm test");
      settingsMock.promoteToSaved.mockRejectedValueOnce(new Error("disk full"));
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        fireEvent.click(screen.getByTestId("quick-run-pin"));
      });
      expect(screen.getByRole("alert").textContent).toContain("docker compose up");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      expect(settingsMock.promoteToSaved).toHaveBeenCalledTimes(2);
      expect(settingsMock.promoteToSaved).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "docker compose up" })
      );
    });

    it("drops the message when the next pin attempt succeeds", async () => {
      seedHistory("docker compose up", "npm test");
      settingsMock.promoteToSaved.mockRejectedValueOnce(new Error("disk full"));
      render(<Footer projectId="test-project" />);
      const input = openPanel();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        fireEvent.keyDown(input, pinKey);
      });
      expect(screen.getByRole("alert").textContent).toContain("docker compose up");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        fireEvent.keyDown(input, pinKey);
      });
      expect(settingsMock.promoteToSaved).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "npm test" })
      );
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("when the history can't be read or saved", () => {
    /** What AppLayout's section boundary does to the sidebar when a render throws. */
    class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? <div data-testid="section-fallback" /> : this.props.children;
      }
    }

    const quotaError = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const accessDenied = () => new DOMException("Access is denied.", "SecurityError");

    const degradedNotice = vi.fn();
    // A structural failure parks writes in a memory map shared by the whole module,
    // so each test uses a project of its own rather than inheriting the last one's.
    let projectNumber = 0;
    let projectId: string;
    let historyKey: string;
    let autoRestartKey: string;
    let historyWrites: string[];

    /** Makes the history key's reads or writes fail, recording every attempted write. */
    function failHistory(method: "getItem" | "setItem", error: () => Error) {
      if (method === "getItem") {
        vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
          if (key === historyKey) throw error();
          return storageMap.get(key) ?? null;
        });
        return;
      }
      vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
        if (key === historyKey) {
          historyWrites.push(value);
          throw error();
        }
        storageMap.set(key, value);
      });
    }

    function renderFooter(strict = false) {
      const tree = (
        <SectionBoundary>
          <Footer projectId={projectId} />
        </SectionBoundary>
      );
      return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    }

    async function launch(command: string) {
      mockAddTerminal.mockResolvedValue(undefined);
      typeAndEnter(command);
      await act(async () => {});
    }

    function recentCommands() {
      fireEvent.keyDown(screen.getByPlaceholderText("Run a command"), { key: "ArrowDown" });
      return commandOptions().map((o) => o.textContent);
    }

    beforeEach(() => {
      projectId = `history-failure-${++projectNumber}`;
      historyKey = `daintree_cmd_history_${projectId}`;
      autoRestartKey = `daintree_quickrun_autorestart_${projectId}`;
      historyWrites = [];
      setPermanentFallbackHandler(degradedNotice);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      setPermanentFallbackHandler(null);
      degradedNotice.mockReset();
      vi.restoreAllMocks();
    });

    it("renders when reading the stored history throws, and points at the degraded-storage notice", async () => {
      failHistory("getItem", accessDenied);
      renderFooter();

      expect(screen.queryByTestId("section-fallback")).toBeNull();
      expect(openPanel()).not.toBeNull();
      expect(degradedNotice).toHaveBeenCalledTimes(1);

      await launch("npm test");
      expect(recentCommands()).toEqual([expect.stringContaining("npm test")]);
    });

    it("keeps a launch that succeeded when saving its history hits the storage quota", async () => {
      failHistory("setItem", quotaError);
      setupPendingTerminal();
      renderFooter();

      typeAndEnter("npm test");
      // Recording waits for the terminal to exist.
      expect(historyWrites).toEqual([]);
      await act(async () => resolveTerminal());

      expect(historyWrites).toHaveLength(1);
      expect(screen.queryByTestId("section-fallback")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect((screen.getByPlaceholderText("Run a command") as HTMLInputElement).value).toBe("");
      expect(recentCommands()).toEqual([expect.stringContaining("npm test")]);
      // A full quota is transient; storage is still healthy, so no degraded-storage notice.
      expect(degradedNotice).not.toHaveBeenCalled();
    });

    it("records nothing for a launch that failed", async () => {
      failHistory("setItem", quotaError);
      setupPendingTerminal();
      renderFooter();

      typeAndEnter("npm test");
      await act(async () => rejectTerminal(new Error("spawn failed")));

      expect(screen.getByRole("alert")).not.toBeNull();
      expect(historyWrites).toEqual([]);
      expect(storageMap.has(historyKey)).toBe(false);
    });

    it("keeps a command the quota refused when the panel is closed and reopened", async () => {
      failHistory("setItem", quotaError);
      renderFooter();
      await launch("npm test");

      fireEvent.click(screen.getByRole("button", { name: /run command/i }));
      expect(screen.queryByPlaceholderText("Run a command")).toBeNull();
      openPanel();

      expect(recentCommands()).toEqual([expect.stringContaining("npm test")]);
    });

    it("keeps history in memory and raises the notice once when storage fails structurally", async () => {
      failHistory("setItem", accessDenied);
      renderFooter();

      await launch("npm test");
      await launch("npm run lint");

      expect(screen.queryByTestId("section-fallback")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(recentCommands()).toEqual([
        expect.stringContaining("npm run lint"),
        expect.stringContaining("npm test"),
      ]);
      expect(degradedNotice).toHaveBeenCalledTimes(1);
      // Once storage is known broken, it isn't hit again.
      expect(historyWrites).toHaveLength(1);
    });

    it("writes the history once per launch under StrictMode, not once per updater run", async () => {
      const setItem = vi.spyOn(localStorage, "setItem");
      renderFooter(true);

      await launch("npm test");

      expect(setItem.mock.calls.filter(([key]) => key === historyKey)).toHaveLength(1);
      expect(recentCommands()).toEqual([expect.stringContaining("npm test")]);
    });

    it("writes the auto-restart choice once per toggle under StrictMode", () => {
      const setItem = vi.spyOn(localStorage, "setItem");
      renderFooter(true);
      openPanel();
      const toggle = screen.getByRole("button", { name: "Auto-restart" });

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).toBe("false");

      expect(setItem.mock.calls.filter(([key]) => key === autoRestartKey)).toEqual([
        [autoRestartKey, "true"],
        [autoRestartKey, "false"],
      ]);
    });

    it("starts from an empty history when the stored one is malformed", () => {
      for (const stored of [
        "{not json",
        JSON.stringify([null]),
        JSON.stringify([{ command: 7, timestamp: 1 }]),
        JSON.stringify({ command: "npm test", timestamp: 1 }),
      ]) {
        storageMap.set(historyKey, stored);
        const view = renderFooter();
        fireEvent.keyDown(openPanel(), { key: "ArrowDown" });

        expect(screen.queryByTestId("section-fallback")).toBeNull();
        expect(screen.queryAllByRole("option")).toEqual([]);
        expect(storageMap.has(historyKey)).toBe(false);
        view.unmount();
        resetQuickRunHistoryForTests();
      }
    });
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
