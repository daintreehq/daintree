import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_RESTART_STARTUP_SAMPLES } from "../../../shared/config/memoryLeakPolicy.js";
import type { TerminalResourceBatchPayload } from "../../../shared/types/pty-host.js";
import {
  AUTO_RESTART_RETRY_MS,
  MemoryLeakAutoRestartService,
  type MemoryLeakRestartTarget,
  type MemoryLeakTerminalRead,
} from "../MemoryLeakAutoRestartService.js";

const THRESHOLD_MB = 1024;
const OVER_KB = THRESHOLD_MB * 1024 + 1;
const UNDER_KB = THRESHOLD_MB * 1024;

function harness(
  options: {
    target?: MemoryLeakRestartTarget;
    terminal?: MemoryLeakTerminalRead | null;
    enabled?: boolean;
  } = {}
) {
  let metricsListener: ((metrics: TerminalResourceBatchPayload) => void) | null = null;
  let exitListener: ((id: string) => void) | null = null;
  const policy = { enabled: options.enabled ?? true, thresholdMb: THRESHOLD_MB };
  const generations = new Map<string, number>();
  const terminal = {
    value: options.terminal === undefined ? { projectId: "p1" } : options.terminal,
  };
  const clock = { now: 0 };
  const deliver = vi.fn();
  const target = {
    value: options.target ?? ({ kind: "view", deliver } as MemoryLeakRestartTarget),
  };
  const restartOnHost = vi.fn(
    async (_projectId: string, _terminalId: string, _isCurrent: () => boolean) => "restarted"
  );
  const readTerminal = vi.fn(
    async (_id: string): Promise<MemoryLeakTerminalRead | null> => terminal.value
  );
  const offMetrics = vi.fn();
  const service = new MemoryLeakAutoRestartService({
    onMetrics: (listener) => {
      metricsListener = listener;
      return offMetrics;
    },
    onExit: (listener) => {
      exitListener = listener;
      return () => {};
    },
    readPolicy: () => policy,
    generationOf: (id) => generations.get(id),
    readTerminal,
    pickTarget: () => target.value,
    restartOnHost,
    now: () => clock.now,
  });

  const sample = async (memoryKb: number, id = "t1", times = 1) => {
    for (let i = 0; i < times; i++) {
      metricsListener?.({ [id]: { cpuPercent: 0, memoryKb } });
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return {
    service,
    policy,
    generations,
    terminal,
    clock,
    deliver,
    target,
    restartOnHost,
    readTerminal,
    offMetrics,
    sample,
    exit: (id: string) => exitListener?.(id),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MemoryLeakAutoRestartService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a terminal its startup samples before the threshold applies", async () => {
    const h = harness();
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES - 1);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    await h.sample(OVER_KB);
    await flush();
    expect(h.deliver).toHaveBeenCalledWith(
      { terminalId: "t1", thresholdMb: THRESHOLD_MB },
      expect.any(Function)
    );
  });

  it("restarts only above the threshold, not at it", async () => {
    const h = harness();
    await h.sample(UNDER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES + 5);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("asks the one view once, however many samples arrive before the retry interval", async () => {
    const h = harness();
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES + 10);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);

    h.clock.now = AUTO_RESTART_RETRY_MS;
    await h.sample(OVER_KB);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it("restarts on the host when no view is attached", async () => {
    const h = harness({ target: { kind: "host" } });
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    expect(h.restartOnHost).toHaveBeenCalledTimes(1);
    expect(h.restartOnHost).toHaveBeenCalledWith("p1", "t1", expect.any(Function));
  });

  it("never restarts a terminal waiting for input, and tries again later", async () => {
    const h = harness({ terminal: { projectId: "p1", agentState: "waiting" } });
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    h.terminal.value = { projectId: "p1", agentState: "working" };
    await h.sample(OVER_KB);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();

    h.clock.now = AUTO_RESTART_RETRY_MS;
    await h.sample(OVER_KB);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("lets the host restart see a relaunch that lands after the decision", async () => {
    const h = harness({ target: { kind: "host" } });
    h.generations.set("t1", 1);
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    const isCurrent = h.restartOnHost.mock.calls[0]![2];
    expect(isCurrent()).toBe(true);

    h.generations.set("t1", 2);
    expect(isCurrent()).toBe(false);
  });

  it("waits while the project's driver is away", async () => {
    const h = harness({ target: { kind: "wait" } });
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    expect(h.restartOnHost).not.toHaveBeenCalled();
  });

  it("starts the startup grace over for a new launch under the same id", async () => {
    const h = harness();
    h.generations.set("t1", 1);
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);

    h.generations.set("t1", 2);
    h.clock.now = AUTO_RESTART_RETRY_MS;
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES - 1);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("drops a decision whose terminal was relaunched while it was being checked", async () => {
    const h = harness();
    h.generations.set("t1", 1);
    let answer: (read: MemoryLeakTerminalRead) => void = () => {};
    h.readTerminal.mockImplementationOnce(
      () => new Promise<MemoryLeakTerminalRead>((resolve) => (answer = resolve))
    );
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);

    h.generations.set("t1", 2);
    answer({ projectId: "p1" });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("forgets a terminal that exits", async () => {
    const h = harness();
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES - 1);
    h.exit("t1");
    await h.sample(OVER_KB);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("does nothing while the host's policy is off", async () => {
    const h = harness({ enabled: false });
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES + 1);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.restartOnHost).not.toHaveBeenCalled();
  });

  it("skips a terminal that belongs to no project", async () => {
    const h = harness({ terminal: { projectId: null } });
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("stops listening on dispose", () => {
    const h = harness();
    h.service.dispose();
    expect(h.offMetrics).toHaveBeenCalled();
  });
});
