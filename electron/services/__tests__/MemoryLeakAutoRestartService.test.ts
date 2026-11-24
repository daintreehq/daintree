import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_RESTART_STARTUP_SAMPLES } from "../../../shared/config/memoryLeakPolicy.js";
import type { TerminalResourceBatchPayload } from "../../../shared/types/pty-host.js";
import {
  AUTO_RESTART_RETRY_MS,
  MemoryLeakAutoRestartService,
  type MemoryLeakHostRestartGuards,
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
    async (_projectId: string, _terminalId: string, _guards: MemoryLeakHostRestartGuards) =>
      "restarted"
  );
  const readTerminal = vi.fn(
    async (_id: string): Promise<MemoryLeakTerminalRead | null> => terminal.value
  );
  const offMetrics = vi.fn();
  // A fresh object per read, as the store gives: a service holding on to one
  // read must not see later changes through it.
  const readPolicy = vi.fn(() => ({ ...policy }));
  const service = new MemoryLeakAutoRestartService({
    onMetrics: (listener) => {
      metricsListener = listener;
      return offMetrics;
    },
    onExit: (listener) => {
      exitListener = listener;
      return () => {};
    },
    readPolicy,
    generationOf: (id) => generations.get(id),
    readTerminal,
    pickTarget: () => target.value,
    restartOnHost,
    now: () => clock.now,
  });

  const sample = async (memoryKb: number, id = "t1", times = 1) => {
    for (let i = 0; i < times; i++) {
      metricsListener?.({ [id]: { cpuPercent: 0, memoryKb, breakdown: [] } });
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
    readPolicy,
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
    expect(h.restartOnHost).toHaveBeenCalledWith("p1", "t1", {
      isCurrent: expect.any(Function),
      stillWanted: expect.any(Function),
    });
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
    const { isCurrent } = h.restartOnHost.mock.calls[0]![2];
    expect(isCurrent()).toBe(true);

    h.generations.set("t1", 2);
    expect(isCurrent()).toBe(false);
  });

  it("lets the host restart see its decision dropped, while its own kill's exit leaves the launch current", async () => {
    const h = harness({ target: { kind: "host" } });
    h.generations.set("t1", 1);
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    const { isCurrent, stillWanted } = h.restartOnHost.mock.calls[0]![2];
    expect(stillWanted()).toBe(true);

    h.policy.enabled = false;
    expect(stillWanted()).toBe(false);
    expect(isCurrent()).toBe(true);
  });

  it("lets its own kill's exit drop the host restart's decision but leave the launch current", async () => {
    const h = harness({ target: { kind: "host" } });
    h.generations.set("t1", 1);
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    const { isCurrent, stillWanted } = h.restartOnHost.mock.calls[0]![2];

    h.exit("t1");
    expect(stillWanted()).toBe(false);
    expect(isCurrent()).toBe(true);
  });

  it("lets the host restart see the service stop", async () => {
    const h = harness({ target: { kind: "host" } });
    await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
    await flush();
    const { isCurrent, stillWanted } = h.restartOnHost.mock.calls[0]![2];

    h.service.dispose();
    expect(isCurrent()).toBe(false);
    expect(stillWanted()).toBe(false);
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

  describe("a decision still pending", () => {
    async function pendingDecision() {
      const h = harness();
      let answer: (read: MemoryLeakTerminalRead) => void = () => {};
      h.readTerminal.mockImplementationOnce(
        () => new Promise<MemoryLeakTerminalRead>((resolve) => (answer = resolve))
      );
      await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
      expect(h.readTerminal).toHaveBeenCalledTimes(1);
      return { h, settle: () => answer({ projectId: "p1" }) };
    }

    it("is dropped when the policy is turned off before the lookup settles", async () => {
      const { h, settle } = await pendingDecision();
      h.policy.enabled = false;
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when the policy is turned off, a batch arrives, and it is turned on again", async () => {
      const { h, settle } = await pendingDecision();
      h.policy.enabled = false;
      await h.sample(OVER_KB);
      h.policy.enabled = true;
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when the threshold rises above the latest sample", async () => {
      const { h, settle } = await pendingDecision();
      h.policy.thresholdMb = THRESHOLD_MB * 2;
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when the threshold rises above a newer sample, though not the one it was taken on", async () => {
      const h = harness();
      let answer: (read: MemoryLeakTerminalRead) => void = () => {};
      h.readTerminal.mockImplementationOnce(
        () => new Promise<MemoryLeakTerminalRead>((resolve) => (answer = resolve))
      );
      await h.sample(UNDER_KB * 3, "t1", AUTO_RESTART_STARTUP_SAMPLES);
      await h.sample(UNDER_KB * 1.5);
      h.policy.thresholdMb = THRESHOLD_MB * 2;
      answer({ projectId: "p1" });
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when the policy is turned off and on again with no batch or check between", async () => {
      const { h, settle } = await pendingDecision();
      h.policy.enabled = false;
      h.service.policyChanged();
      h.policy.enabled = true;
      h.service.policyChanged();
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when the threshold is raised to a newer sample and lowered again with no batch or check between", async () => {
      const h = harness();
      let answer: (read: MemoryLeakTerminalRead) => void = () => {};
      h.readTerminal.mockImplementationOnce(
        () => new Promise<MemoryLeakTerminalRead>((resolve) => (answer = resolve))
      );
      await h.sample(UNDER_KB * 3, "t1", AUTO_RESTART_STARTUP_SAMPLES);
      await h.sample(UNDER_KB * 1.5);
      h.policy.thresholdMb = THRESHOLD_MB * 1.5;
      h.service.policyChanged();
      h.policy.thresholdMb = THRESHOLD_MB;
      h.service.policyChanged();
      answer({ projectId: "p1" });
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when a policy write can't be read back, without failing the write", async () => {
      const { h, settle } = await pendingDecision();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.readPolicy.mockImplementationOnce(() => {
        throw new Error("store unreadable");
      });
      expect(() => h.service.policyChanged()).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("survives a policy write that still backs it", async () => {
      const { h, settle } = await pendingDecision();
      h.policy.thresholdMb = THRESHOLD_MB / 2;
      h.service.policyChanged();
      settle();
      await flush();
      expect(h.deliver).toHaveBeenCalledTimes(1);
    });

    it("is dropped when its terminal exits before the lookup settles", async () => {
      const { h, settle } = await pendingDecision();
      h.exit("t1");
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("is dropped when the service stops before the lookup settles", async () => {
      const { h, settle } = await pendingDecision();
      h.service.dispose();
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("survives a batch that recovers only another terminal", async () => {
      const { h, settle } = await pendingDecision();
      await h.sample(UNDER_KB, "t2");
      settle();
      await flush();
      expect(h.deliver).toHaveBeenCalledTimes(1);
    });

    it("is dropped when a newer sample comes back under the threshold", async () => {
      const { h, settle } = await pendingDecision();
      await h.sample(UNDER_KB);
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("stays dropped when a sample climbs back over after recovering", async () => {
      const { h, settle } = await pendingDecision();
      await h.sample(UNDER_KB);
      await h.sample(OVER_KB);
      settle();
      await flush();
      expect(h.deliver).not.toHaveBeenCalled();
    });

    it("still goes ahead when the threshold drops but the latest sample stays over it", async () => {
      const { h, settle } = await pendingDecision();
      h.policy.thresholdMb = THRESHOLD_MB / 2;
      settle();
      await flush();
      expect(h.deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe("a view delivery that runs later", () => {
    async function delivered() {
      const h = harness();
      await h.sample(OVER_KB, "t1", AUTO_RESTART_STARTUP_SAMPLES);
      await flush();
      expect(h.deliver).toHaveBeenCalledTimes(1);
      const isCurrent = h.deliver.mock.calls[0]![1] as () => boolean;
      expect(isCurrent()).toBe(true);
      return { h, isCurrent };
    }

    it("no longer holds once the policy is turned off", async () => {
      const { h, isCurrent } = await delivered();
      h.policy.enabled = false;
      expect(isCurrent()).toBe(false);
    });

    it("no longer holds once the threshold rises above the latest sample", async () => {
      const { h, isCurrent } = await delivered();
      h.policy.thresholdMb = THRESHOLD_MB * 2;
      expect(isCurrent()).toBe(false);
    });

    it("no longer holds once the terminal is relaunched", async () => {
      const { h, isCurrent } = await delivered();
      h.generations.set("t1", 7);
      expect(isCurrent()).toBe(false);
    });

    it("no longer holds once the policy was turned off and on again with no batch between", async () => {
      const { h, isCurrent } = await delivered();
      h.policy.enabled = false;
      h.service.policyChanged();
      h.policy.enabled = true;
      h.service.policyChanged();
      expect(isCurrent()).toBe(false);
    });

    it("no longer holds when the policy can't be read, and a later decision still goes ahead", async () => {
      const { h, isCurrent } = await delivered();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.readPolicy.mockImplementationOnce(() => {
        throw new Error("store unreadable");
      });
      expect(isCurrent()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(isCurrent()).toBe(false);

      h.clock.now = AUTO_RESTART_RETRY_MS;
      await h.sample(OVER_KB);
      await flush();
      expect(h.deliver).toHaveBeenCalledTimes(2);
      expect((h.deliver.mock.calls[1]![1] as () => boolean)()).toBe(true);
    });

    it("no longer holds once a newer sample recovers", async () => {
      const { h, isCurrent } = await delivered();
      await h.sample(UNDER_KB);
      expect(isCurrent()).toBe(false);
    });

    it("stays dropped once the threshold falls back under the usage", async () => {
      const { h, isCurrent } = await delivered();
      h.policy.thresholdMb = THRESHOLD_MB * 2;
      expect(isCurrent()).toBe(false);
      h.policy.thresholdMb = THRESHOLD_MB;
      expect(isCurrent()).toBe(false);
    });

    it("no longer holds once a newer decision replaces it", async () => {
      const { h, isCurrent } = await delivered();
      h.clock.now = AUTO_RESTART_RETRY_MS;
      await h.sample(OVER_KB);
      await flush();
      expect(h.deliver).toHaveBeenCalledTimes(2);
      expect(isCurrent()).toBe(false);
      expect((h.deliver.mock.calls[1]![1] as () => boolean)()).toBe(true);
    });

    it("no longer holds once the policy was turned off and on again", async () => {
      const { h, isCurrent } = await delivered();
      h.policy.enabled = false;
      await h.sample(OVER_KB);
      h.policy.enabled = true;
      expect(isCurrent()).toBe(false);
    });
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
