import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import { createHostShutdown, type HostShutdownDeps } from "../hostShutdown.js";

const PENDING = { parcelSubscriptions: 2, parcelLifecycleOps: 1 };

function setup(overrides: Partial<HostShutdownDeps> = {}) {
  const steps: string[] = [];
  const sent: WorkspaceHostEvent[] = [];
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
    now: () => 0,
    ...overrides,
  };
  return { shutdown: createHostShutdown(deps), steps, sent, exit };
}

describe("createHostShutdown (#12460)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports, disposes, settles, acks, then exits on the next turn", async () => {
    const { shutdown, steps, sent } = setup();

    await shutdown();
    expect(steps).toEqual([
      "send:dispose-progress:disposing-services",
      "dispose:workspace",
      "dispose:forge",
      "send:dispose-progress:settling",
      "settle",
      "send:disposed",
    ]);
    expect(sent.at(-1)).toEqual({
      type: "disposed",
      elapsedMs: 0,
      settled: true,
      pending: PENDING,
    });

    // The ack gets a turn to flush before the process dies.
    vi.advanceTimersByTime(0);
    expect(steps.at(-1)).toBe("exit:0");
  });

  it("keeps disposing after one disposer throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { shutdown, steps } = setup({
      disposers: [
        () => {
          throw new Error("boom");
        },
        () => steps.push("dispose:forge"),
      ],
    });

    await shutdown();
    expect(steps).toContain("dispose:forge");
    expect(steps).toContain("send:disposed");
    warn.mockRestore();
  });

  it("acks with settled:false when the watcher drain outlives its budget", async () => {
    const { shutdown, sent, exit } = setup({
      settle: () => new Promise<void>(() => {}),
      settleBudgetMs: 300,
      exitDeadlineMs: 500,
    });

    const done = shutdown();
    await vi.advanceTimersByTimeAsync(300);
    await done;

    expect(sent.at(-1)).toMatchObject({ type: "disposed", settled: false });
    // Scheduled mid-tick, so the fake clock queues the immediate at +1ms —
    // well before the 500ms deadline, so this exit came from the ack path.
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits on the hard deadline even when nothing acks", async () => {
    const { shutdown, sent, exit } = setup({
      settle: () => new Promise<void>(() => {}),
      settleBudgetMs: 10_000,
      exitDeadlineMs: 500,
    });

    void shutdown();
    await vi.advanceTimersByTimeAsync(500);

    expect(exit).toHaveBeenCalledWith(0);
    expect(sent.some((event) => event.type === "disposed")).toBe(false);
    // The parent still learns where the host was when it gave up.
    expect(sent.at(-1)).toMatchObject({ type: "dispose-progress", phase: "settling" });
  });

  it("runs once no matter how many triggers arrive", async () => {
    const disposer = vi.fn();
    const { shutdown } = setup({ disposers: [disposer] });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await first;
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it("still exits when the port is gone", async () => {
    const { shutdown, exit } = setup({
      send: () => {
        throw new Error("port closed");
      },
    });

    await shutdown();
    vi.advanceTimersByTime(0);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
