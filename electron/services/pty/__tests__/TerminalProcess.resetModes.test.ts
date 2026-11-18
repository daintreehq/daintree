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
    wasKilled?: boolean;
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
  return vi.waitFor(() => expect(info.pendingHeadlessWrites ?? 0).toBe(0), { timeout: 10_000 });
}

afterEach(() => {
  for (const terminal of live.splice(0)) terminal.dispose();
});

type AnalysisInternals = { analysis: { feedModeReset: (data: string) => boolean } };

function spyMirrorFeed(terminal: TerminalProcess, order?: string[]) {
  const analysis = (terminal as unknown as AnalysisInternals).analysis;
  const original = analysis.feedModeReset.bind(analysis);
  return vi.spyOn(analysis, "feedModeReset").mockImplementation((data) => {
    order?.push("mirror");
    return original(data);
  });
}

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

  it("hands the mirror the reset before the pane, so a snapshot fenced at the pane's offset includes it", () => {
    const order: string[] = [];
    const { terminal, emitted } = createHarness();
    spyMirrorFeed(terminal, order);
    const emittedBefore = emitted.length;
    const originalPush = emitted.push.bind(emitted);
    emitted.push = (...items) => {
      order.push("pane");
      return originalPush(...items);
    };

    terminal.resetTerminalModes();

    expect(order).toEqual(["mirror", "pane"]);
    expect(emitted.length).toBe(emittedBefore + 1);
  });

  it("sends the pane nothing when the mirror can't take the reset in order", () => {
    const { terminal, emitted } = createHarness();
    const feed = spyMirrorFeed(terminal);
    feed.mockReturnValue(false);

    expect(terminal.resetTerminalModes()).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("leaves output that follows the reset in charge of the modes", async () => {
    const { terminal, output, mirror } = createHarness();
    output("\x1b[?2004h");
    terminal.resetTerminalModes();
    await mirrorSettled(terminal);
    expect(mirror.modes.bracketedPasteMode).toBe(false);

    output("\x1b[?2004h");

    await mirrorSettled(terminal);
    expect(mirror.modes.bracketedPasteMode).toBe(true);
  });

  it("parses behind output the mirror scheduler is still holding", async () => {
    const { terminal, output, mirror } = createHarness();
    // Over the scheduler's 128K in-flight cap, so this output is queued in
    // slices rather than fed at once; the modes it sets come last.
    output("x".repeat(200_000) + "\x1b[?1000h\x1b[?2004h");
    terminal.resetTerminalModes();

    await mirrorSettled(terminal);
    expect(mirror.modes.mouseTrackingMode).toBe("none");
    expect(mirror.modes.bracketedPasteMode).toBe(false);
  });

  it("keeps a mode set right after the reset, queued behind it in the mirror", async () => {
    const { terminal, output, mirror } = createHarness();
    output("\x1b[?1000h\x1b[?2004h");
    terminal.resetTerminalModes();
    output("\x1b[?2004h");

    await mirrorSettled(terminal);
    expect(mirror.modes.bracketedPasteMode).toBe(true);
    expect(mirror.modes.mouseTrackingMode).toBe("none");
  });

  it.each([
    ["an exited pane", (info: Internals["terminalInfo"]) => (info.isExited = true)],
    ["a killed pane", (info: Internals["terminalInfo"]) => (info.wasKilled = true)],
    [
      "a pane showing the snapshot it kept at exit",
      (info: Internals["terminalInfo"]) => (info.preservedSnapshot = { data: "kept" }),
    ],
  ])("refuses %s, touching neither the mirror nor the pane", (_name, mark) => {
    const { terminal, emitted } = createHarness();
    const feed = spyMirrorFeed(terminal);
    mark((terminal as unknown as Internals).terminalInfo);

    expect(terminal.resetTerminalModes()).toBe(false);
    expect(feed).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});
