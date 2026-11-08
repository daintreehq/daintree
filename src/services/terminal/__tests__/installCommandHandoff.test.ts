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
const recheckPrerequisites = vi.hoisted(() => vi.fn());
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
vi.mock("@/lib/recheckMissingPrerequisites", () => ({
  recheckMissingPrerequisites: recheckPrerequisites,
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: {
    getState: () => ({ refresh: cli.refresh, availability: cli.availability }),
  },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import {
  __testing,
  openInstallCommandInTerminal,
  type InstallTarget,
} from "../installCommandHandoff";
import { installLineForCommands } from "../installCommandLine";

/** Just enough of an xterm for the prompt wait: its cursor line, its modes, its writes. */
function fakeTerminal() {
  const parsed = new Set<() => void>();
  const terminal = {
    line: "",
    modes: { bracketedPasteMode: false },
    buffer: {
      active: {
        type: "normal" as "normal" | "alternate",
        baseY: 0,
        cursorY: 0,
        cursorX: 0,
        getLine: () => ({ translateToString: () => terminal.line }),
      },
    },
    onWriteParsed: (cb: () => void) => {
      parsed.add(cb);
      return { dispose: () => parsed.delete(cb) };
    },
    /** The shell drew something: the cursor line becomes `line`. */
    print(line: string) {
      terminal.line = line;
      terminal.buffer.active.cursorX = line.length;
      for (const cb of [...parsed]) cb();
    },
  };
  return terminal;
}

const GIT: InstallTarget = { kind: "prerequisite", tool: "git" };
const REQUEST = { line: "sudo apt-get install git", target: GIT, cwd: "/home/u", worktreeId: "wt" };

let terminal: ReturnType<typeof fakeTerminal>;

function emitActivity(status: string, terminalId = "t1") {
  for (const cb of [...client.activity]) cb({ terminalId, status });
}

/** Opens the line and lets the shell come up at a bash 5 prompt. */
async function openAtPrompt(request = REQUEST) {
  const opened = openInstallCommandInTerminal(request);
  await vi.advanceTimersByTimeAsync(50);
  terminal.modes.bracketedPasteMode = true;
  terminal.print("u@host:~$");
  await vi.advanceTimersByTimeAsync(300);
  return opened;
}

beforeEach(() => {
  vi.useFakeTimers();
  __testing.reset();
  vi.clearAllMocks();
  panels.listeners.clear();
  client.activity.clear();
  client.exit.clear();
  terminal = fakeTerminal();
  panels.state.panelsById = {};
  panels.state.addPanel.mockImplementation(async () => {
    panels.state.panelsById = {
      t1: { id: "t1", kind: "terminal", location: "grid", spawnStatus: "ready" },
    };
    return "t1";
  });
  service.waitForInstance.mockResolvedValue(undefined);
  service.get.mockImplementation((id: string) => (id === "t1" ? { terminal } : undefined));
  load.mockResolvedValue(service);
  recheckPrerequisites.mockResolvedValue([{ tool: "git" }]);
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
    // Trailing whitespace is trimmed, never typed.
    expect(installLineForCommands(["echo a\r\n"], "macos")).toBe("echo a");
    expect(installLineForCommands(["git\tclone"], "macos")).toBe(null);
    expect(installLineForCommands([], "macos")).toBe(null);
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
  });

  it("waits for the shell to start before typing", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    // A login shell still starting: nothing on screen, no line editor yet.
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

  it("takes an unfamiliar prompt once the shell's output has stopped", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(50);
    terminal.print("custom-theme ::");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    await opened;
    expect(client.write).toHaveBeenCalledWith("t1", REQUEST.line);
  });

  it("types nothing when no prompt comes, and says so", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(await opened).toBe("t1");
    expect(client.write).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({ type: "warning" });
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

  it("opens one terminal for a double click", async () => {
    const first = openInstallCommandInTerminal(REQUEST);
    const second = openInstallCommandInTerminal(REQUEST);
    expect(await second).toBe(null);
    terminal.modes.bracketedPasteMode = true;
    terminal.print("$");
    await vi.advanceTimersByTimeAsync(300);
    await first;

    expect(panels.state.addPanel).toHaveBeenCalledTimes(1);
    expect(client.write).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a line that would submit itself", async () => {
    expect(await openInstallCommandInTerminal({ ...REQUEST, line: "a\nb" })).toBe(null);
    expect(panels.state.addPanel).not.toHaveBeenCalled();
  });

  it("stops when the panel limit refuses the terminal", async () => {
    panels.state.addPanel.mockResolvedValue(null);

    expect(await openInstallCommandInTerminal(REQUEST)).toBe(null);
    expect(load).not.toHaveBeenCalled();
    expect(__testing.watchCount()).toBe(0);
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
    expect(recheckPrerequisites).not.toHaveBeenCalled();

    emitActivity("working");
    emitActivity("success");
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisites).toHaveBeenCalledTimes(1);
    expect(__testing.watchCount()).toBe(1);

    recheckPrerequisites.mockResolvedValue([]);
    emitActivity("working");
    emitActivity("success");
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisites).toHaveBeenCalledTimes(2);
    expect(__testing.watchCount()).toBe(0);
    expect(client.activity.size).toBe(0);
    expect(client.exit.size).toBe(0);
    expect(panels.listeners.size).toBe(0);
  });

  it("ignores other terminals' activity", async () => {
    await openAtPrompt();
    emitActivity("working", "t2");
    emitActivity("success", "t2");
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisites).not.toHaveBeenCalled();
  });

  it("checks once more and stops when the terminal closes", async () => {
    await openAtPrompt();
    panels.set({});
    await vi.advanceTimersByTimeAsync(0);

    expect(recheckPrerequisites).toHaveBeenCalledTimes(1);
    expect(__testing.watchCount()).toBe(0);
    panels.set({});
    expect(recheckPrerequisites).toHaveBeenCalledTimes(1);
  });

  it("checks once more and stops when the shell exits", async () => {
    await openAtPrompt();
    for (const cb of [...client.exit]) cb("t1", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(recheckPrerequisites).toHaveBeenCalledTimes(1);
    expect(__testing.watchCount()).toBe(0);
  });

  it("watches even when the line couldn't be typed, since the user may paste it", async () => {
    const opened = openInstallCommandInTerminal(REQUEST);
    await vi.advanceTimersByTimeAsync(25_000);
    await opened;

    emitActivity("working");
    emitActivity("success");
    await vi.advanceTimersByTimeAsync(0);
    expect(recheckPrerequisites).toHaveBeenCalledTimes(1);
  });

  it("refreshes CLI availability for an agent and stops once it's installed", async () => {
    await openAtPrompt({
      ...REQUEST,
      line: "curl -fsSL x | bash",
      target: { kind: "agent", agentId: "claude" },
    });
    cli.refresh.mockImplementation(async () => {
      cli.availability = { claude: "ready" };
    });

    emitActivity("working");
    emitActivity("success");
    await vi.advanceTimersByTimeAsync(0);

    expect(cli.refresh).toHaveBeenCalledWith(true);
    expect(recheckPrerequisites).not.toHaveBeenCalled();
    expect(__testing.watchCount()).toBe(0);
  });

  it("lets a watch lapse after an hour", async () => {
    await openAtPrompt();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(__testing.watchCount()).toBe(0);
  });
});
