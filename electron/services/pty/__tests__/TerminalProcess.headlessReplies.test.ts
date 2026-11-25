import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const CPR_QUERY = "\x1b[6n";
const CPR_REPLY = "\x1b[1;1R";
const DSR_QUERY = "\x1b[5n";
const DSR_REPLY = "\x1b[0n";

let ptyWrite: ReturnType<typeof vi.fn<(data: string) => void>>;
let feedPty: ((data: string) => void) | null;
let viewAnswers: boolean;
let terminals: TerminalProcess[];
let nextId = 0;

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => ptyWrite(data),
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      feedPty = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

function createPlainTerminal(withProbe = true): TerminalProcess {
  const ctx: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };
  const proc = new TerminalProcess(
    `t${++nextId}`,
    { cwd: process.cwd(), cols: 80, rows: 24, kind: "terminal", projectId: "p1" },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: { handleActivityState: () => {} } as never,
      ptyPool: null,
      processTreeCache: null,
      ...(withProbe ? { hasAnsweringView: () => viewAnswers } : {}),
    },
    ctx,
    createMockPty()
  );
  terminals.push(proc);
  return proc;
}

function ptyWrites(): string[] {
  return ptyWrite.mock.calls.map(([data]) => data);
}

// Replies are decided as the mirror parses, on its own schedule. A marker
// after the query lands in the mirror's screen only once the query is parsed.
async function feedAndParse(proc: TerminalProcess, data: string, marker: string): Promise<void> {
  feedPty!(data + marker);
  await vi.waitFor(() => {
    const line = proc.getInfo().headlessTerminal?.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toContain(marker);
  });
}

describe("TerminalProcess headless replies (#18185)", () => {
  beforeEach(() => {
    ptyWrite = vi.fn<(data: string) => void>();
    feedPty = null;
    viewAnswers = false;
    terminals = [];
  });

  afterEach(() => {
    // The mock PTY's pid is no process of ours; teardown only signals it.
    vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const proc of terminals) proc.dispose();
    vi.restoreAllMocks();
  });

  it("answers a plain terminal's queries when no view is parsing it", async () => {
    const proc = createPlainTerminal();

    await feedAndParse(proc, CPR_QUERY + DSR_QUERY, "a");

    expect(ptyWrites()).toEqual([CPR_REPLY, DSR_REPLY]);
  });

  it("leaves the replies to the view while one parses the terminal's output", async () => {
    const proc = createPlainTerminal();
    viewAnswers = true;

    await feedAndParse(proc, CPR_QUERY + DSR_QUERY, "a");

    expect(ptyWrites()).toEqual([]);
  });

  it("decides per reply, after the responder is already installed", async () => {
    const proc = createPlainTerminal();

    await feedAndParse(proc, CPR_QUERY, "a");
    expect(ptyWrites()).toEqual([CPR_REPLY]);

    viewAnswers = true;
    await feedAndParse(proc, DSR_QUERY + CPR_QUERY, "b");
    expect(ptyWrites()).toEqual([CPR_REPLY]);

    viewAnswers = false;
    await feedAndParse(proc, DSR_QUERY, "c");
    expect(ptyWrites()).toEqual([CPR_REPLY, DSR_REPLY]);
  });

  it("keeps answering when nothing reports on views", async () => {
    const proc = createPlainTerminal(false);

    await feedAndParse(proc, CPR_QUERY, "a");

    expect(ptyWrites()).toEqual([CPR_REPLY]);
  });
});
