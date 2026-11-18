import { afterEach, describe, expect, it, vi } from "vitest";
import { stubProcessKillForFile } from "../../../__tests__/helpers/processKillGuard.js";
import type { IPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { TerminalProcess } from "../TerminalProcess.js";
import { TERMINAL_MODE_RESET } from "../terminalModeReset.js";
import { encodeUtf8 } from "../encodeUtf8.js";

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(async () => []),
  killWindowsProcessTreesSync: vi.fn(() => []),
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

stubProcessKillForFile(600);

type TerminalProcessCallbacks = ConstructorParameters<typeof TerminalProcess>[2];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

type Internals = {
  terminalInfo: {
    headlessTerminal?: HeadlessTerminal;
    pendingHeadlessWrites?: number;
    isExited?: boolean;
    preservedSnapshot?: unknown;
  };
};

interface Harness {
  terminal: TerminalProcess;
  output: (data: string) => void;
  emitted: Array<{ data: string; streamEnd: number }>;
  ptyWrite: ReturnType<typeof vi.fn>;
  mirror: HeadlessTerminal;
}

const live: TerminalProcess[] = [];

function createHarness(): Harness {
  let onData: ((data: string) => void) | null = null;
  const ptyWrite = vi.fn();
  const pty = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: ptyWrite,
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    destroy: vi.fn(),
    onData: (cb: (data: string) => void) => {
      onData = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
  const emitted: Harness["emitted"] = [];
  const callbacks: Partial<TerminalProcessCallbacks> = {
    emitData: (_id, data, streamEnd) => emitted.push({ data, streamEnd }),
  };
  const terminal = new TerminalProcess(
    "t1",
    { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal" },
    { emitData: () => {}, onExit: () => {}, ...callbacks },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
    },
    { shell: "/bin/zsh", args: ["-l"], env: {} },
    pty
  );
  live.push(terminal);
  const mirror = (terminal as unknown as Internals).terminalInfo.headlessTerminal;
  if (!mirror) throw new Error("expected an in-thread headless mirror");
  return { terminal, output: (data) => onData!(data), emitted, ptyWrite, mirror };
}

/** Resolves once the mirror has parsed every write queued so far. */
function mirrorSettled(terminal: TerminalProcess): Promise<void> {
  const info = (terminal as unknown as Internals).terminalInfo;
  return vi.waitFor(() => expect(info.pendingHeadlessWrites ?? 0).toBe(0), { timeout: 2000 });
}

afterEach(() => {
  for (const terminal of live.splice(0)) terminal.dispose();
});

describe("TerminalProcess.resetTerminalModes (#17328)", () => {
  it("sends the pane and the mirror the reset after the output before it, and the process nothing", async () => {
    const { terminal, output, emitted, ptyWrite, mirror } = createHarness();
    output("$ tui\x1b[?1000h\x1b[?1006h\x1b[?2004h");

    expect(terminal.resetTerminalModes()).toBe(true);

    expect(emitted.map((e) => e.data)).toEqual([
      "$ tui\x1b[?1000h\x1b[?1006h\x1b[?2004h",
      TERMINAL_MODE_RESET,
    ]);
    // The stream offset a snapshot is fenced at counts the reset's bytes.
    expect(emitted[1].streamEnd - emitted[0].streamEnd).toBe(
      encodeUtf8(TERMINAL_MODE_RESET).byteLength
    );
    expect(ptyWrite).not.toHaveBeenCalled();

    await mirrorSettled(terminal);
    expect(mirror.modes.mouseTrackingMode).toBe("none");
    expect(mirror.modes.bracketedPasteMode).toBe(false);
    expect(terminal.isBracketedPasteMode()).toBe(false);
  });

  it("leaves output that follows the reset in charge of the modes", async () => {
    const { terminal, output, mirror } = createHarness();
    output("\x1b[?2004h");
    terminal.resetTerminalModes();
    output("\x1b[?2004h");

    await mirrorSettled(terminal);
    expect(mirror.modes.bracketedPasteMode).toBe(true);
  });

  it("refuses an exited pane", () => {
    const { terminal, emitted } = createHarness();
    (terminal as unknown as Internals).terminalInfo.isExited = true;

    expect(terminal.resetTerminalModes()).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("leaves a preserved exit snapshot as it was captured", () => {
    const { terminal, emitted } = createHarness();
    (terminal as unknown as Internals).terminalInfo.preservedSnapshot = { data: "kept" };

    expect(terminal.resetTerminalModes()).toBe(false);
    expect(emitted).toEqual([]);
  });
});
