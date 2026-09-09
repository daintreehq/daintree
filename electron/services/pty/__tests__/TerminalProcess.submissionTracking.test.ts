import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { TerminalInputController } from "../TerminalInputController.js";

/**
 * #12337 end to end through the pty-host side of the submit path: a caller's
 * token in, a phase out, with the real `TerminalInputController` doing the
 * encoding and gating.
 *
 * Driven through `TerminalProcess` rather than against `WriteQueue` directly
 * because the interesting phases are decided by `performSubmit`'s guards, and
 * those only exist here.
 */

let ptyWriteMock: ReturnType<typeof vi.fn<(data: string) => void>>;

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      ptyWriteMock(data);
    },
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return pty as IPty;
}

function defaultSpawnContext(): SpawnContext {
  return { shell: "/bin/zsh", args: ["-l"], env: {} };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  onSubmitStatus?: (id: string, state: string) => void
): TerminalProcess {
  const merged = {
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    kind: "terminal" as const,
    ...options,
  };
  return new TerminalProcess(
    "t1",
    merged,
    { emitData: () => {}, onExit: () => {}, onSubmitStatus },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentStateService: { handleActivityState: () => {} } as any,
      ptyPool: null,
      processTreeCache: null,
    },
    defaultSpawnContext(),
    createMockPty()
  );
}

/** The shutdown input lock, reached the way `gracefulShutdown` reaches it. */
function acquireInputLock(terminal: TerminalProcess): () => void {
  return (
    terminal as unknown as { inputController: TerminalInputController }
  ).inputController.acquireShutdownInputLock();
}

describe("TerminalProcess submission tracking (#12337)", () => {
  beforeEach(() => {
    ptyWriteMock = vi.fn<(data: string) => void>();
  });

  it("records pty_written once the body and its Enter have both gone out", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("test\n", "tok-1");
    // Mid-submit the body is out but the Enter is not, and that is precisely
    // the window in which the old surface said nothing at all.
    expect(terminal.getSubmission("tok-1")?.phase).toBe("writing");

    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
    vi.useRealTimers();
  });

  it("records pty_written for a bare Enter", async () => {
    const terminal = createTerminal();

    terminal.submit("", "tok-1");

    expect(ptyWriteMock).toHaveBeenCalledWith("\r");
    await Promise.resolve();
    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
  });

  it("records failed when the Enter write throws instead of logging it away", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    ptyWriteMock.mockImplementation((data) => {
      if (data === "\r") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    terminal.submit("test\n", "tok-1");
    await vi.advanceTimersByTimeAsync(250);

    // Before this, `write()` swallowed the throw into `logWriteError`, so a
    // genuine dead pipe never reached the failure branch and the submission
    // looked as though it had gone out.
    expect(terminal.getSubmission("tok-1")?.phase).toBe("failed");
    vi.useRealTimers();
  });

  it("records failed when the body write throws, and never sends a bare Enter after it", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();
    ptyWriteMock.mockImplementation((data) => {
      if (data === "test") throw Object.assign(new Error("write EIO"), { code: "EIO" });
    });

    terminal.submit("test\n", "tok-1");
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.getSubmission("tok-1")?.phase).toBe("failed");
    expect(ptyWriteMock).not.toHaveBeenCalledWith("\r");
    vi.useRealTimers();
  });

  it("records cancelled when a shutdown lock lands between the body and its Enter", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("test\n", "tok-1");
    expect(ptyWriteMock).toHaveBeenCalledWith("test");

    // The exact silent loss the issue describes: the body is in the composer,
    // the Enter is abandoned, and nothing else on this surface would say so.
    acquireInputLock(terminal);
    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).not.toHaveBeenCalledWith("\r");
    expect(terminal.getSubmission("tok-1")?.phase).toBe("cancelled");
    vi.useRealTimers();
  });

  it("records cancelled for a submission refused because input is locked", () => {
    const terminal = createTerminal();
    acquireInputLock(terminal);

    terminal.submit("test\n", "tok-1");

    expect(ptyWriteMock).not.toHaveBeenCalled();
    // Answered, not silent: `unknown` would be indistinguishable from a token
    // this terminal never saw.
    expect(terminal.getSubmission("tok-1")?.phase).toBe("cancelled");
  });

  it("retains nothing for an untracked submit", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    // What in-app typing and fleet broadcast do.
    terminal.submit("test\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(ptyWriteMock).toHaveBeenLastCalledWith("\r");
    expect(terminal.getSubmission("tok-1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("surfaces an untracked submit's synchronous write error as a failed status", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const terminal = createTerminal(undefined, (_id, state) => statuses.push(state));
    ptyWriteMock.mockImplementation((data) => {
      if (data === "\r") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    // No token: this is in-app typing / fleet broadcast. Before the strict
    // write path, `write()` swallowed the throw into `logWriteError` and the
    // submit lane never heard about it. Driven through the real
    // TerminalInputController so restoring the swallow fails this test.
    terminal.submit("test\n");
    await vi.advanceTimersByTimeAsync(250);

    expect(statuses).toEqual(["failed"]);
    vi.useRealTimers();
  });

  it("keeps a burst of tokens separately answerable", async () => {
    vi.useFakeTimers();
    const terminal = createTerminal();

    terminal.submit("one\n", "tok-1");
    terminal.submit("two\n", "tok-2");
    await vi.advanceTimersByTimeAsync(1000);

    expect(terminal.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(terminal.getSubmission("tok-2")?.phase).toBe("pty_written");
    vi.useRealTimers();
  });
});
