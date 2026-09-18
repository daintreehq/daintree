import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import { createHostShutdown, type HostShutdownDeps } from "../hostShutdown.js";

const PENDING = { parcelSubscriptions: 2, parcelLifecycleOps: 1 };

function setup(overrides: Partial<HostShutdownDeps> = {}) {
  const steps: string[] = [];
  const sent: WorkspaceHostEvent[] = [];
  let clock = 0;
  const exit = vi.fn((code: number) => {
    steps.push(`exit:${code}`);
  });
  const deps: HostShutdownDeps = {
    disposers: [() => steps.push("dispose:workspace"), () => steps.push("dispose:forge")],
    settle: async () => {
      steps.push("settle");
    },
    getPending: () => PENDING,
    send: (event) => {
      sent.push(event);
      steps.push(`send:${event.type}${"phase" in event ? `:${event.phase}` : ""}`);
    },
    exit,
    now: () => clock,
    writeTailMs: 500,
    settleBudgetMs: 300,
    exitDeadlineMs: 1_000,
    ...overrides,
  };
  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return { shutdown: createHostShutdown(deps), steps, sent, exit, advance };
}

describe("createHostShutdown (#12460)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disposes, settles, holds the write-tail window, then acks and exits on the next turn", async () => {
    const { shutdown, steps, sent, exit, advance } = setup();

    const done = shutdown();
    await advance(499);
    expect(steps).toEqual([
      "send:dispose-progress:disposing-services",
      "dispose:workspace",
      "dispose:forge",
      "send:dispose-progress:settling",
      "settle",
      "send:dispose-progress:write-tail",
    ]);

    await advance(1);
    await done;
    expect(sent.at(-1)).toEqual({
      type: "disposed",
      elapsedMs: 500,
      settled: true,
      pending: PENDING,
    });
    expect(exit).not.toHaveBeenCalled();

    // Scheduled mid-tick, so the fake clock queues the immediate at +1ms —
    // well before the 1s deadline, so this exit came from the ack path.
    await advance(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps disposing after one disposer throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { shutdown, steps, advance } = setup({
      disposers: [
        () => {
          throw new Error("boom");
        },
        () => steps.push("dispose:forge"),
      ],
    });

    const done = shutdown();
    await advance(500);
    await done;
    expect(steps).toContain("dispose:forge");
    expect(steps).toContain("send:disposed");
    warn.mockRestore();
  });

  it.each([
    ["outlives its budget", () => new Promise<void>(() => {})],
    ["rejects", () => Promise.reject(new Error("native teardown failed"))],
    [
      "throws synchronously",
      () => {
        throw new Error("native teardown failed");
      },
    ],
  ])("acks with settled:false when the watcher drain %s", async (_label, settle) => {
    const { shutdown, sent, exit, advance } = setup({ settle });

    const done = shutdown();
    await advance(500);
    await done;

    expect(sent.at(-1)).toMatchObject({ type: "disposed", settled: false });
    await advance(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits on the hard deadline when the ack path stalls", async () => {
    const { shutdown, sent, exit, advance } = setup({
      settle: () => new Promise<void>(() => {}),
      settleBudgetMs: 10_000,
    });

    void shutdown();
    await advance(999);
    expect(exit).not.toHaveBeenCalled();
    await advance(1);

    expect(exit).toHaveBeenCalledWith(0);
    expect(sent.some((event) => event.type === "disposed")).toBe(false);
    // The parent still learns where the host was when it gave up.
    expect(sent.at(-1)).toMatchObject({ type: "dispose-progress", phase: "settling" });
  });

  it("has the deadline pending before any disposer runs", async () => {
    const exits: number[] = [];
    const { shutdown } = setup({
      // A disposer that blocks this thread past the deadline: the timer that
      // fires once it frees up must already exist.
      disposers: [() => vi.advanceTimersByTime(1_000)],
      exit: () => exits.push(0),
    });

    void shutdown();
    expect(exits).toEqual([0]);
  });

  it("runs once no matter how many triggers arrive", async () => {
    const disposer = vi.fn();
    const { shutdown, advance } = setup({ disposers: [disposer] });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await advance(500);
    await first;
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "the port is gone",
      {
        send: () => {
          throw new Error("port closed");
        },
      },
    ],
    [
      "the pending snapshot throws",
      {
        getPending: () => {
          throw new Error("stats unavailable");
        },
      },
    ],
  ])("still exits through the ack path when %s", async (_label, overrides) => {
    const { shutdown, exit, advance } = setup(overrides);

    const done = shutdown();
    await advance(500);
    await expect(done).resolves.toBeUndefined();
    await advance(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
