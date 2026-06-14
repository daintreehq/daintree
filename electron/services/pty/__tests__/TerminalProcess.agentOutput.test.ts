import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { events } from "../../events.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

let ptyOnDataCallback: ((data: string) => void) | null = null;

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      ptyOnDataCallback = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  const withDestroy = pty as Partial<IPty> & { destroy: () => void };
  withDestroy.destroy = vi.fn();
  return pty as IPty;
}

function defaultSpawnContext(): SpawnContext {
  return {
    shell: "/bin/zsh",
    args: ["-l"],
    env: {},
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(
  options?: Partial<TerminalProcessOptions>,
  deps?: Partial<TerminalProcessDeps>
): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal" as const,
      ...options,
    },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
      ...deps,
    },
    defaultSpawnContext(),
    createMockPty()
  );
}

describe("TerminalProcess agent:output coalescing", () => {
  let received: Array<{ agentId: string; data: string; terminalId?: string }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    received = [];
    unsubscribe = events.on("agent:output", (payload) => {
      received.push(payload);
    });
  });

  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("coalesces multiple chunks into one emit on the flush timer", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    expect(ptyOnDataCallback).not.toBeNull();

    ptyOnDataCallback!("chunk-a");
    ptyOnDataCallback!("chunk-b");
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(received).toHaveLength(1);
    expect(received[0].agentId).toBe("claude");
    expect(received[0].data).toBe("chunk-achunk-b");
    expect(received[0].terminalId).toBe("t1");

    terminal.dispose();
  });

  it("flushes immediately when pending output reaches the size cap", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });
    const big = "x".repeat(2500);

    ptyOnDataCallback!(big);
    expect(received).toHaveLength(1);
    expect(received[0].data).toBe(big);

    terminal.dispose();
  });

  it("emits nothing for plain terminals", () => {
    const terminal = createTerminal();

    ptyOnDataCallback!("plain shell output");
    vi.advanceTimersByTime(100);
    expect(received).toHaveLength(0);

    terminal.dispose();
  });

  it("flushes pending output before the kill transition", () => {
    const order: string[] = [];
    const offOrder = events.on("agent:output", () => {
      order.push("output");
    });
    const terminal = createTerminal(
      { launchAgentId: "claude" },
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {
            order.push("state");
          },
          emitAgentKilled: () => {},
        } as unknown as TerminalProcessDeps["agentStateService"],
      }
    );

    ptyOnDataCallback!("tail-data");
    expect(received).toHaveLength(0);

    terminal.kill("user requested");

    expect(received).toHaveLength(1);
    expect(received[0].data).toBe("tail-data");
    expect(order).toEqual(["output", "state"]);

    offOrder();
    terminal.dispose();
  });

  it("flushes pending output on dispose without waiting for the timer", () => {
    const terminal = createTerminal({ launchAgentId: "claude" });

    ptyOnDataCallback!("last-words");
    expect(received).toHaveLength(0);

    terminal.dispose();
    expect(received).toHaveLength(1);
    expect(received[0].data).toBe("last-words");
  });
});
