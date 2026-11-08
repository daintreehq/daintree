// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatForTerminalPaste } from "@shared/utils/terminalInputProtocol";

type Listener = (state: PanelState) => void;
interface PanelState {
  panelsById: Record<string, unknown>;
  addPanel: ReturnType<typeof vi.fn>;
}

const panels = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>();
  const state = { panelsById: {} as Record<string, unknown>, addPanel: vi.fn() };
  return {
    state,
    listeners,
    set(panelsById: Record<string, unknown>) {
      state.panelsById = panelsById;
      for (const listener of [...listeners]) listener(state);
    },
  };
});
const client = vi.hoisted(() => ({
  write: vi.fn(),
  activity: new Set<(payload: { terminalId: string; status: string }) => void>(),
  exit: new Set<(id: string, code: number) => void>(),
}));
const service = vi.hoisted(() => ({
  waitForInstance: vi.fn(),
  get: vi.fn(),
  focus: vi.fn(),
}));
const load = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const recheckPrerequisite = vi.hoisted(() => vi.fn());
const cli = vi.hoisted(() => ({
  refresh: vi.fn(),
  availability: {} as Record<string, string>,
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => panels.state,
    subscribe: (listener: Listener) => {
      panels.listeners.add(listener as (state: unknown) => void);
      return () => panels.listeners.delete(listener as (state: unknown) => void);
    },
  },
}));
vi.mock("@/clients", () => ({
  terminalClient: {
    write: client.write,
    onActivity: (cb: (payload: { terminalId: string; status: string }) => void) => {
      client.activity.add(cb);
      return () => client.activity.delete(cb);
    },
    onExit: (cb: (id: string, code: number) => void) => {
      client.exit.add(cb);
      return () => client.exit.delete(cb);
    },
  },
}));
vi.mock("../terminalInstanceServiceAccessor", () => ({ load }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/lib/recheckMissingPrerequisites", () => ({ recheckPrerequisite }));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: {
    getState: () => ({ refresh: cli.refresh, availability: cli.availability }),
  },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import {
  __testing,
  openInstallCommandInTerminal,
  type InstallCommandRequest,
} from "../installCommandHandoff";
import { installLineForCommands } from "../installCommandLine";

/** Rows above the viewport, and the cursor's row within it: the prompt is at 5. */
const BASE_Y = 3;
const CURSOR_Y = 2;

/** Just enough of an xterm for the prompt wait: its rows, its modes, its writes. */
function fakeTerminal() {
  const parsed = new Set<() => void>();
  const lines: string[] = [];
  // Scrollback from before: a prompt on a row the cursor is not on.
  lines[CURSOR_Y] = "old@host:~$";
  const terminal = {
    modes: { bracketedPasteMode: false },
    buffer: {
      active: {
        type: "normal" as "normal" | "alternate",
        baseY: BASE_Y,
        cursorY: CURSOR_Y,
        getLine: (y: number) => ({ translateToString: () => lines[y] ?? "" }),
      },
    },
    onWriteParsed: (cb: () => void) => {
      parsed.add(cb);
      return { dispose: () => parsed.delete(cb) };
    },
    /** The shell drew something on the cursor's row. */
    print(line: string) {
      lines[BASE_Y + CURSOR_Y] = line;
      for (const cb of [...parsed]) cb();
    },
    listenerCount: () => parsed.size,
  };
  return terminal;
}

const REQUEST: InstallCommandRequest = {
  line: "sudo apt-get install git",
  target: { kind: "prerequisite", tool: "git" },
  cwd: "/home/u",
  worktreeId: "wt",
};
const AGENT_REQUEST: InstallCommandRequest = {
  ...REQUEST,
  line: "curl -fsSL https://claude.ai/install.sh | bash",
  target: { kind: "agent", agentId: "claude" },
};

let terminal: ReturnType<typeof fakeTerminal>;

function emitActivity(status: string, terminalId = "t1") {
  for (const cb of [...client.activity]) cb({ terminalId, status });
}

/** A command ran in the terminal and finished. */
async function runCommand() {
  emitActivity("working");
  emitActivity("success");
  await vi.advanceTimersByTimeAsync(0);
}

/** Opens the line and lets the shell come up at a bash 5 prompt. */
async function openAtPrompt(request: InstallCommandRequest = REQUEST) {
  const opened = openInstallCommandInTerminal(request);
  await vi.advanceTimersByTimeAsync(50);
  terminal.modes.bracketedPasteMode = true;
  terminal.print("u@host:~$");
  await vi.advanceTimersByTimeAsync(300);
  return opened;
}

function seedTerminal(status: "ready" | "failed" = "ready") {
  panels.set({ t1: { id: "t1", kind: "terminal", location: "grid", spawnStatus: status } });
}

beforeEach(() => {
  vi.useFakeTimers();
  __testing.reset();
  vi.clearAllMocks();
  panels.listeners.clear();
  client.activity.clear();
  client.exit.clear();
  terminal = fakeTerminal();
  const managed = { terminal };
  panels.state.panelsById = {};
  panels.state.addPanel.mockImplementation(async () => {
    seedTerminal();
    return "t1";
  });
  service.waitForInstance.mockResolvedValue(undefined);
  service.get.mockImplementation((id: string) => (id === "t1" ? managed : undefined));
  load.mockResolvedValue(service);
  recheckPrerequisite.mockResolvedValue(false);
  cli.refresh.mockResolvedValue(undefined);
  cli.availability = {};
});

afterEach(() => {
  __testing.reset();
  vi.useRealTimers();
});

describe("installLineForCommands", () => {
  it("joins a POSIX block into the one line it runs as", () => {
    expect(installLineForCommands(["curl -fsSL x | bash", " npm i -g y "], "linux")).toBe(
      "curl -fsSL x | bash && npm i -g y"
    );
  });

  it("has no single line for a Windows block of several steps", () => {
    expect(
      installLineForCommands(["scoop bucket add charm", "scoop install crush"], "windows")
    ).toBe(null);
    expect(installLineForCommands(["winget install Git.Git"], "windows")).toBe(
      "winget install Git.Git"
    );
  });

  it("refuses a command that would submit or complete itself when typed", () => {
    expect(installLineForCommands(["echo a\nrm -rf b"], "linux")).toBe(null);
    expect(installLineForCommands(["echo a\rrm -rf b"], "macos")).toBe(null);
    expect(installLineForCommands(["git\tclone"], "macos")).toBe(null);
    expect(installLineForCommands(["echo a", "b\nc"], "linux")).toBe(null);
    expect(installLineForCommands([], "macos")).toBe(null);
    // Trailing whitespace is trimmed, never typed.
    expect(installLineForCommands(["echo a\r\n"], "macos")).toBe("echo a");
  });
});

describe("openInstallCommandInTerminal", () => {
  it("types the line at the new shell's prompt without pressing Enter", async () => {
    const opened = await openAtPrompt();

    expect(opened).toBe("t1");
    const options = panels.state.addPanel.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      kind: "terminal",
      cwd: "/home/u",
      worktreeId: "wt",
      location: "grid",
      focusPolicy: "take",
    });
    // Never a spawn command: that runs at once.
    expect(options.command).toBeUndefined();
    expect(client.write).toHaveBeenCalledTimes(1);
    const [id, data] = client.write.mock.calls[0]!;
    expect(id).toBe("t1");
    expect(data).toBe(formatForTerminalPaste(REQUEST.line, { bracketedPasteMode: true }));
    expect(data).not.toMatch(/[\r\n]/);
    expect(service.focus).toHaveBeenCalledWith("t1");
    // The output listener went with the wait.
    expect(terminal.listenerCount()).toBe(0);
  });

  it("waits for the shell to start before typing", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    // A login shell still starting: the cursor row is blank, no line editor
    // yet, and the prompt in the scrollback is not where the cursor is.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.write).not.toHaveBeenCalled();

    // PowerShell has no bracketed paste; its prompt shape is enough.
    terminal.print("PS C:\\Users\\u>");
    await vi.advanceTimersByTimeAsync(300);

    expect(await opened).toBe("t1");
    expect(client.write).toHaveBeenCalledWith("t1", REQUEST.line);
  });

  it("doesn't type into a prompt still being drawn", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(50);
    terminal.modes.bracketedPasteMode = true;
    for (let i = 0; i < 10; i += 1) {
      terminal.print(`frame ${i} %`);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.write).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(300);
    await opened;
    expect(client.write).toHaveBeenCalledTimes(1);
  });

  it("never types at a startup password prompt, however long it waits", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(50);
    terminal.print("Enter passphrase for /home/u/.ssh/id_ed25519:");
    await vi.advanceTimersByTimeAsync(25_000);

    expect(await opened).toBe("t1");
    expect(client.write).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({ type: "warning" });
    expect(terminal.listenerCount()).toBe(0);
  });

  it("types nothing into an alternate screen", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(50);
    terminal.buffer.active.type = "alternate";
    terminal.modes.bracketedPasteMode = true;
    terminal.print("$");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.write).not.toHaveBeenCalled();

    terminal.buffer.active.type = "normal";
    await vi.advanceTimersByTimeAsync(300);
    await opened;
    expect(client.write).toHaveBeenCalledTimes(1);
  });

  it("opens one terminal for a double click, and another for a later click", async () => {
    const first = openInstallCommandInTerminal(REQUEST);
    const second = openInstallCommandInTerminal(REQUEST);
    expect(await second).toBe(null);
    terminal.modes.bracketedPasteMode = true;
    terminal.print("$");
    await vi.advanceTimersByTimeAsync(300);
    await first;
    expect(panels.state.addPanel).toHaveBeenCalledTimes(1);
    expect(client.write).toHaveBeenCalledTimes(1);

    await openAtPrompt();
    expect(panels.state.addPanel).toHaveBeenCalledTimes(2);
  });

  it("opens nothing for a line that would submit itself", async () => {
    expect(await openInstallCommandInTerminal({ ...REQUEST, line: "a\nb" })).toBe(null);
    expect(panels.state.addPanel).not.toHaveBeenCalled();
  });

  it("stops when the panel limit refuses the terminal, and can be asked again", async () => {
    panels.state.addPanel.mockResolvedValueOnce(null);

    expect(await openInstallCommandInTerminal(REQUEST)).toBe(null);
    expect(load).not.toHaveBeenCalled();
    expect(__testing.watchCount()).toBe(0);

    expect(await openAtPrompt()).toBe("t1");
  });

  it("types nothing into a terminal closed before its prompt came", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(50);
    panels.set({});
    terminal.modes.bracketedPasteMode = true;
    terminal.print("$");
    await vi.advanceTimersByTimeAsync(300);

    expect(await opened).toBe(null);
    expect(client.write).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("re-checking after the command runs", () => {
  it("re-checks when the terminal goes from running to idle, and stops once the tool is there", async () => {
    await openAtPrompt();
    // Idle with nothing having run (the shell settling) asks nothing.
    emitActivity("success");
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisite).not.toHaveBeenCalled();

    await runCommand();
    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);
    expect(recheckPrerequisite).toHaveBeenCalledWith("git");
    expect(__testing.watchCount()).toBe(1);

    recheckPrerequisite.mockResolvedValue(true);
    await runCommand();
    expect(recheckPrerequisite).toHaveBeenCalledTimes(2);
    expect(__testing.watchCount()).toBe(0);
    expect(client.activity.size).toBe(0);
    expect(client.exit.size).toBe(0);
    expect(panels.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing is left to fire.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(recheckPrerequisite).toHaveBeenCalledTimes(2);
  });

  it("runs one check at a time, and checks again for a command that finished meanwhile", async () => {
    await openAtPrompt();
    let settle!: (resolved: boolean) => void;
    recheckPrerequisite.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (settle = resolve))
    );

    await runCommand();
    await runCommand();
    await runCommand();
    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);

    settle(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisite).toHaveBeenCalledTimes(2);
  });

  it("ignores other terminals' activity", async () => {
    await openAtPrompt();
    await runCommand();
    recheckPrerequisite.mockClear();
    emitActivity("working", "t2");
    emitActivity("success", "t2");
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisite).not.toHaveBeenCalled();
  });

  it("also re-checks on its own for a while, for an install busy and idle missed", async () => {
    await openAtPrompt();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const polled = recheckPrerequisite.mock.calls.length;
    expect(polled).toBeGreaterThan(1);
    expect(polled).toBeLessThanOrEqual(30);
    // Past the window only a finished command asks again; the watch lives on.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(recheckPrerequisite).toHaveBeenCalledTimes(polled);
    expect(__testing.watchCount()).toBe(1);
  });

  it("stops re-checking on its own once the tool is there", async () => {
    await openAtPrompt();
    recheckPrerequisite.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(__testing.watchCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);
  });

  it("checks once more and stops when the terminal closes", async () => {
    await openAtPrompt();
    panels.set({});
    await vi.advanceTimersByTimeAsync(0);

    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);
    expect(__testing.watchCount()).toBe(0);
    panels.set({});
    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);
  });

  it("stops when the terminal's spawn fails", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(50);
    seedTerminal("failed");
    await vi.advanceTimersByTimeAsync(200);

    expect(await opened).toBe(null);
    expect(__testing.watchCount()).toBe(0);
    expect(client.activity.size).toBe(0);
  });

  it("checks once more and stops when the shell exits", async () => {
    await openAtPrompt();
    for (const cb of [...client.exit]) cb("t1", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);
    expect(__testing.watchCount()).toBe(0);
  });

  it("watches even when the line couldn't be typed, since the user may paste it", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(25_000);
    await opened;
    expect(client.write).not.toHaveBeenCalled();
    recheckPrerequisite.mockClear();

    await runCommand();
    expect(recheckPrerequisite).toHaveBeenCalledTimes(1);
  });

  it("refreshes CLI availability for an agent until it is installed", async () => {
    await openAtPrompt(AGENT_REQUEST);
    cli.refresh.mockImplementation(async () => {
      cli.availability = { claude: "missing" };
    });

    await runCommand();
    expect(cli.refresh).toHaveBeenCalledWith(true);
    expect(__testing.watchCount()).toBe(1);

    cli.refresh.mockImplementation(async () => {
      cli.availability = { claude: "unauthenticated" };
    });
    await runCommand();
    expect(cli.refresh).toHaveBeenCalledTimes(2);
    expect(recheckPrerequisite).not.toHaveBeenCalled();
    expect(__testing.watchCount()).toBe(0);
  });

  it("lets a watch lapse after an hour", async () => {
    await openAtPrompt();
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1_000);
    expect(__testing.watchCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(__testing.watchCount()).toBe(0);
    expect(client.activity.size).toBe(0);
    expect(panels.listeners.size).toBe(0);
  });
});
