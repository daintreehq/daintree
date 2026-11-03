import { afterEach, describe, expect, it, vi } from "vitest";
import { stubProcessKillForFile } from "../../../__tests__/helpers/processKillGuard.js";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import { AnalysisWorkerPool, type WorkerLike } from "../analysis/AnalysisWorkerPool.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { HostToWorkerMessage, WorkerToHostMessage } from "../analysisWorkerProtocol.js";

/**
 * #16210 through the pty-host side: a tokened send's Enter starts a capture
 * beside the mirror, and `getSubmission` hands back what rendered after it.
 */

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(async () => []),
  killWindowsProcessTreesSync: vi.fn(() => []),
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

/** Pty writes and worker posts, in the order they happened. */
let timeline: string[] = [];

class FakeWorker implements WorkerLike {
  posted: HostToWorkerMessage[] = [];
  private listeners = new Map<string, Array<(arg: never) => void>>();

  postMessage(msg: unknown): void {
    const message = msg as HostToWorkerMessage;
    this.posted.push(message);
    timeline.push(`post:${message.type}`);
  }

  on(event: string, cb: (arg: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  unref(): void {}

  emit(msg: WorkerToHostMessage): void {
    for (const cb of this.listeners.get("message") ?? []) (cb as (a: unknown) => void)(msg);
  }
}

let onPtyData: ((data: string) => void) | null = null;
let onPtyExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 40,
    rows: 10,
    write: (data: string) => {
      timeline.push(`pty:${data}`);
    },
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      onPtyData = cb;
      return { dispose: () => {} };
    },
    onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => {
      onPtyExit = cb;
      return { dispose: () => {} };
    },
  };
  return pty as IPty;
}

const terminals: TerminalProcess[] = [];

function createTerminal(pool?: AnalysisWorkerPool): TerminalProcess {
  const ctx: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };
  const terminal = new TerminalProcess(
    "t1",
    { cwd: process.cwd(), cols: 40, rows: 10, kind: "terminal" as const },
    { emitData: () => {}, onExit: () => {} },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentStateService: { handleActivityState: () => {}, updateAgentState: () => {} } as any,
      ptyPool: null,
      processTreeCache: null,
      ...(pool !== undefined ? { analysisWorkerPool: pool } : {}),
    },
    ctx,
    createMockPty()
  );
  terminals.push(terminal);
  return terminal;
}

function createWorkerTerminal(): { terminal: TerminalProcess; worker: FakeWorker } {
  const workers: FakeWorker[] = [];
  const pool = new AnalysisWorkerPool(1, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const terminal = createTerminal(pool);
  return { terminal, worker: workers[0]! };
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\r\n`).join("");
}

async function sendAndWait(terminal: TerminalProcess, text: string, token?: string): Promise<void> {
  terminal.submit(text, token);
  if (token === undefined) {
    await vi.waitFor(() => expect(terminal.hasPendingSubmission()).toBe(false));
    return;
  }
  await vi.waitFor(() => expect(terminal.getSubmission(token)?.phase).toBe("pty_written"));
}

stubProcessKillForFile(600);

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  onPtyData = null;
  onPtyExit = null;
  timeline = [];
});

describe("TerminalProcess submission output (#16210), in-thread mirror", () => {
  it("reads back the output after a tokened send once it has scrolled off, without what was there before", async () => {
    const terminal = createTerminal();
    onPtyData!(lines("before", 4) + "$ ");
    await sendAndWait(terminal, "ask\n", "tok-1");

    onPtyData!("ask\r\nTHE ANSWER\r\n" + lines("chatter", 60));
    await vi.waitFor(() =>
      expect(terminal.getSubmission("tok-1")?.output?.text).toContain("chatter 60")
    );

    const output = terminal.getSubmission("tok-1")!.output!;
    expect(output.text.split("\n").slice(0, 2)).toEqual(["$ ask", "THE ANSWER"]);
    expect(output.text).not.toContain("before");
    expect(output.state).toBe("capturing");
  });

  it("redacts secrets in what it holds", async () => {
    const terminal = createTerminal();
    onPtyData!("$ ");
    await sendAndWait(terminal, "show\n", "tok-1");
    const key = `AKIA${"A".repeat(16)}`;
    onPtyData!(`show\r\nkey=${key}\r\n` + lines("tail", 12));

    await vi.waitFor(() =>
      expect(terminal.getSubmission("tok-1")?.output?.text).toContain("tail 12")
    );
    expect(terminal.getSubmission("tok-1")!.output!.text).not.toContain(key);
  });

  it("ends a capture at the next submission, tokened or not", async () => {
    const terminal = createTerminal();
    onPtyData!("$ ");
    await sendAndWait(terminal, "first\n", "tok-1");
    onPtyData!("first\r\nfirst answer\r\n$ ");
    await sendAndWait(terminal, "second\n");
    onPtyData!("second\r\nsecond answer\r\n" + lines("more", 20));

    await vi.waitFor(() => expect(terminal.getSubmission("tok-1")?.output?.state).toBe("closed"));
    const output = terminal.getSubmission("tok-1")!.output!;
    expect(output.text).toContain("first answer");
    expect(output.text).not.toContain("second answer");
  });

  it("attaches no output to a record that never reached pty_written", () => {
    const terminal = createTerminal();
    terminal.submit("pending\n", "tok-1");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("writing");
    expect(terminal.getSubmission("tok-1")?.output).toBeUndefined();
  });
});

describe("TerminalProcess submission output (#16210), worker mirror", () => {
  function startMessage(worker: FakeWorker) {
    return worker.posted.find(
      (msg): msg is Extract<HostToWorkerMessage, { type: "submission-capture-start" }> =>
        msg.type === "submission-capture-start"
    );
  }

  it("starts the capture behind the output fed before the write and reads what the worker publishes", async () => {
    const { terminal, worker } = createWorkerTerminal();
    onPtyData!("$ ");
    await sendAndWait(terminal, "ask\n", "tok-1");

    const start = startMessage(worker);
    expect(start).toMatchObject({ terminalId: "t1", text: "ask\n" });
    const startIndex = worker.posted.indexOf(start!);
    const prompt = worker.posted.findIndex((msg) => msg.type === "data" && msg.data.includes("$ "));
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeLessThan(startIndex);

    worker.emit({
      type: "submission-capture",
      terminalId: "t1",
      captureId: start!.captureId,
      output: { text: "$ ask\nan answer", truncated: false, state: "capturing" },
    });
    expect(terminal.getSubmission("tok-1")?.output).toEqual({
      text: "$ ask\nan answer",
      truncated: false,
      state: "capturing",
    });
  });

  it("settles an open capture as lost, on what it last read, when the worker is lost", async () => {
    const { terminal, worker } = createWorkerTerminal();
    await sendAndWait(terminal, "ask\n", "tok-1");
    const start = startMessage(worker)!;
    worker.emit({
      type: "submission-capture",
      terminalId: "t1",
      captureId: start.captureId,
      output: { text: "partial", truncated: false, state: "capturing" },
    });

    (terminal as unknown as { analysis: { handleWorkerLost(): void } }).analysis.handleWorkerLost();
    expect(terminal.getSubmission("tok-1")?.output).toEqual({
      text: "partial",
      truncated: false,
      state: "lost",
    });

    // A late event from the old generation changes nothing.
    worker.emit({
      type: "submission-capture",
      terminalId: "t1",
      captureId: start.captureId,
      output: { text: "late", truncated: false, state: "closed" },
    });
    expect(terminal.getSubmission("tok-1")?.output?.text).toBe("partial");
  });

  it("asks the worker to close the capture before the next submission writes anything", async () => {
    const { terminal } = createWorkerTerminal();
    await sendAndWait(terminal, "ask\n", "tok-1");
    await sendAndWait(terminal, "next\n");
    const start = timeline.indexOf("post:submission-capture-start");
    const close = timeline.indexOf("post:submission-capture-close");
    const nextBody = timeline.findIndex(
      (event) => event.startsWith("pty:") && event.includes("next")
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(start);
    expect(nextBody).toBeGreaterThan(close);
  });

  it("closes the capture ahead of the exit's final snapshot and the slot's release", async () => {
    const { terminal } = createWorkerTerminal();
    await sendAndWait(terminal, "ask\n", "tok-1");
    timeline = [];
    onPtyExit!({ exitCode: 0 });
    await vi.waitFor(() => expect(timeline).toContain("post:submission-capture-close"));
    terminal.dispose();
    const close = timeline.indexOf("post:submission-capture-close");
    const free = timeline.indexOf("post:free");
    expect(free).toBeGreaterThan(close);
    const request = timeline.indexOf("post:request");
    if (request !== -1) expect(request).toBeGreaterThan(close);
  });

  it("settles an open capture as lost when no worker is left to host the terminal", async () => {
    const { terminal } = createWorkerTerminal();
    await sendAndWait(terminal, "ask\n", "tok-1");
    (terminal as unknown as { analysis: { handleDetached(): void } }).analysis.handleDetached();
    expect(terminal.getSubmission("tok-1")?.output?.state).toBe("lost");
  });
});
