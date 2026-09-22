import { describe, it, expect, vi } from "vitest";
import { WaitingWatchdog, type WaitingWatchdogProbeInputs } from "../WaitingWatchdog.js";
import { CpuHighStateTracker } from "../CpuHighStateTracker.js";
import type { ProcessStateValidator } from "../../ActivityMonitor.js";

const SILENCE_MS = 600000;
const TTL_MS = 5000;
const FAIL_THRESHOLD = 3;

function makeWatchdog(opts?: {
  validator?: ProcessStateValidator;
  cpuTracker?: CpuHighStateTracker;
  failThreshold?: number;
}): { watchdog: WaitingWatchdog; onFire: ReturnType<typeof vi.fn> } {
  const onFire = vi.fn<(id: string, spawnedAt: number) => void>();
  const cpuTracker =
    opts?.cpuTracker ??
    new CpuHighStateTracker(undefined, {
      cpuHighThreshold: 10,
      cpuLowThreshold: 3,
      maxCpuHighEscapeMs: 60000,
    });
  const watchdog = new WaitingWatchdog({
    failThreshold: opts?.failThreshold ?? FAIL_THRESHOLD,
    maxWaitingSilenceMs: SILENCE_MS,
    workingIndicatorTtlMs: TTL_MS,
    cpuTracker,
    processStateValidator: opts?.validator,
    onFire,
  });
  return { watchdog, onFire };
}

function deadProbe(_now: number, idleSince: number): WaitingWatchdogProbeInputs {
  return {
    state: "idle",
    idleSince,
    isSpinnerActive: false,
    lastPatternResult: undefined,
    lastPatternResultAt: 0,
    lastDataTimestamp: idleSince, // = idleSince so the > guard rejects it
    terminalId: "term-1",
    spawnedAt: 1000,
  };
}

describe("WaitingWatchdog", () => {
  it("fires after failThreshold consecutive dead-looking ticks", () => {
    const validator: ProcessStateValidator = { hasActiveChildren: () => false };
    const { watchdog, onFire } = makeWatchdog({ validator });

    const idleSince = 1000;
    const start = idleSince + SILENCE_MS;

    watchdog.check(start, deadProbe(start, idleSince)); // 1
    expect(onFire).not.toHaveBeenCalled();
    watchdog.check(start + 5000, deadProbe(start + 5000, idleSince)); // 2
    expect(onFire).not.toHaveBeenCalled();
    watchdog.check(start + 10000, deadProbe(start + 10000, idleSince)); // 3 — fires
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("term-1", 1000);
  });

  it("does not fire before maxWaitingSilenceMs has elapsed", () => {
    const validator: ProcessStateValidator = { hasActiveChildren: () => false };
    const { watchdog, onFire } = makeWatchdog({ validator });

    const idleSince = 1000;
    // Just below the silence threshold.
    watchdog.check(idleSince + SILENCE_MS - 1, deadProbe(idleSince + SILENCE_MS - 1, idleSince));
    watchdog.check(idleSince + SILENCE_MS - 1, deadProbe(idleSince + SILENCE_MS - 1, idleSince));
    watchdog.check(idleSince + SILENCE_MS - 1, deadProbe(idleSince + SILENCE_MS - 1, idleSince));
    expect(onFire).not.toHaveBeenCalled();
  });

  it("does not fire when state is busy", () => {
    const validator: ProcessStateValidator = { hasActiveChildren: () => false };
    const { watchdog, onFire } = makeWatchdog({ validator });

    const idleSince = 1000;
    const now = idleSince + SILENCE_MS + 20000;
    const busy: WaitingWatchdogProbeInputs = { ...deadProbe(now, idleSince), state: "busy" };
    watchdog.check(now, busy);
    watchdog.check(now + 5000, busy);
    watchdog.check(now + 10000, busy);
    watchdog.check(now + 15000, busy);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("only fires once (one-shot until reset)", () => {
    const validator: ProcessStateValidator = { hasActiveChildren: () => false };
    const { watchdog, onFire } = makeWatchdog({ validator });

    const idleSince = 1000;
    const start = idleSince + SILENCE_MS;
    for (let i = 0; i < 10; i++) {
      const now = start + i * 5000;
      watchdog.check(now, deadProbe(now, idleSince));
    }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("reset() rearms the watchdog after a busy cycle", () => {
    const validator: ProcessStateValidator = { hasActiveChildren: () => false };
    const { watchdog, onFire } = makeWatchdog({ validator });

    const firstIdle = 1000;
    const first = firstIdle + SILENCE_MS;
    watchdog.check(first, deadProbe(first, firstIdle));
    watchdog.check(first + 5000, deadProbe(first + 5000, firstIdle));
    watchdog.check(first + 10000, deadProbe(first + 10000, firstIdle));
    expect(onFire).toHaveBeenCalledTimes(1);

    // New idle cycle after a busy → reset
    watchdog.reset();
    const secondIdle = first + 100000;
    const second = secondIdle + SILENCE_MS;
    watchdog.check(second, deadProbe(second, secondIdle));
    watchdog.check(second + 5000, deadProbe(second + 5000, secondIdle));
    watchdog.check(second + 10000, deadProbe(second + 10000, secondIdle));
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  describe("alive vetoes", () => {
    it("active spinner resets failCount", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      watchdog.check(start, deadProbe(start, idleSince)); // failCount=1
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince)); // failCount=2

      // Spinner active — resets failCount
      const aliveProbe: WaitingWatchdogProbeInputs = {
        ...deadProbe(start + 10000, idleSince),
        isSpinnerActive: true,
      };
      watchdog.check(start + 10000, aliveProbe);

      // One more dead tick should not fire — would have without the reset.
      watchdog.check(start + 15000, deadProbe(start + 15000, idleSince)); // failCount=1
      expect(onFire).not.toHaveBeenCalled();
    });

    it("recent working pattern within TTL resets failCount", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      watchdog.check(start, deadProbe(start, idleSince)); // 1
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince)); // 2

      const aliveProbe: WaitingWatchdogProbeInputs = {
        ...deadProbe(start + 10000, idleSince),
        lastPatternResult: { isWorking: true, confidence: 0.9, matchTier: "primary" },
        lastPatternResultAt: start + 8000,
      };
      watchdog.check(start + 10000, aliveProbe);
      watchdog.check(start + 15000, deadProbe(start + 15000, idleSince));
      expect(onFire).not.toHaveBeenCalled();
    });

    it("expired working pattern (older than TTL) does NOT reset", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      const aliveProbe = (now: number): WaitingWatchdogProbeInputs => ({
        ...deadProbe(now, idleSince),
        lastPatternResult: { isWorking: true, confidence: 0.9, matchTier: "primary" },
        lastPatternResultAt: now - TTL_MS - 1, // older than TTL
      });
      watchdog.check(start, aliveProbe(start));
      watchdog.check(start + 5000, aliveProbe(start + 5000));
      watchdog.check(start + 10000, aliveProbe(start + 10000));
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("recent PTY data resets failCount", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      watchdog.check(start, deadProbe(start, idleSince));
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince));

      const aliveProbe: WaitingWatchdogProbeInputs = {
        ...deadProbe(start + 10000, idleSince),
        lastDataTimestamp: start + 9000, // > idleSince and within TTL
      };
      watchdog.check(start + 10000, aliveProbe);
      watchdog.check(start + 15000, deadProbe(start + 15000, idleSince));
      expect(onFire).not.toHaveBeenCalled();
    });

    it("data exactly at idleSince does NOT veto (must be strictly greater)", () => {
      // deadProbe sets lastDataTimestamp = idleSince; this should not count as a veto.
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      watchdog.check(start, deadProbe(start, idleSince));
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince));
      watchdog.check(start + 10000, deadProbe(start + 10000, idleSince));
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("CPU high (and not deadlined) resets failCount", () => {
      const validator: ProcessStateValidator = {
        hasActiveChildren: () => false,
        getDescendantsCpuUsage: () => 50,
      };
      const cpuTracker = new CpuHighStateTracker(validator, {
        cpuHighThreshold: 10,
        cpuLowThreshold: 3,
        maxCpuHighEscapeMs: 60000,
      });
      const { watchdog, onFire } = makeWatchdog({ validator, cpuTracker });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      // First call arms the CPU tracker at `start`. From this moment, the
      // tracker's deadline is `start + 60_000`. Each tick CPU is high → veto.
      watchdog.check(start, deadProbe(start, idleSince));
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince));
      watchdog.check(start + 10000, deadProbe(start + 10000, idleSince));
      watchdog.check(start + 15000, deadProbe(start + 15000, idleSince));
      expect(onFire).not.toHaveBeenCalled();
    });

    it("hasActiveChildren === true resets failCount (alive)", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => true };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      for (let i = 0; i < 5; i++) {
        const now = start + i * 5000;
        watchdog.check(now, deadProbe(now, idleSince));
      }
      expect(onFire).not.toHaveBeenCalled();
    });

    it("missing validator (null) resets failCount — never fires on silence alone", () => {
      // No validator at all.
      const { watchdog, onFire } = makeWatchdog();

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      for (let i = 0; i < 5; i++) {
        const now = start + i * 5000;
        watchdog.check(now, deadProbe(now, idleSince));
      }
      expect(onFire).not.toHaveBeenCalled();
    });

    it("validator throws → treated as alive (true), resets failCount", () => {
      const validator: ProcessStateValidator = {
        hasActiveChildren: () => {
          throw new Error("psutil exploded");
        },
      };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      for (let i = 0; i < 5; i++) {
        const now = start + i * 5000;
        watchdog.check(now, deadProbe(now, idleSince));
      }
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  describe("contract: busy skip does not reset failCount", () => {
    it("partial dead-vote streak persists across a busy tick — only reset() clears it", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      // Accumulate failCount = 2.
      watchdog.check(start, deadProbe(start, idleSince));
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince));
      // Busy tick: early-return, must NOT reset.
      const busyProbe: WaitingWatchdogProbeInputs = {
        ...deadProbe(start + 10000, idleSince),
        state: "busy",
      };
      watchdog.check(start + 10000, busyProbe);
      // One more dead tick → failCount becomes 3 → fires.
      watchdog.check(start + 15000, deadProbe(start + 15000, idleSince));
      expect(onFire).toHaveBeenCalledTimes(1);
    });
  });

  describe("stretched probe cadence", () => {
    const validator: ProcessStateValidator = { hasActiveChildren: () => false };
    const idleSince = 1000;
    const start = idleSince + SILENCE_MS;

    it.each([10000, 15000])(
      "vetoes on output that landed anywhere inside a %ims probe gap",
      (gap) => {
        const { watchdog, onFire } = makeWatchdog({ validator });
        for (let i = 0; i < FAIL_THRESHOLD + 2; i++) {
          const now = start + i * gap;
          watchdog.check(now, {
            ...deadProbe(now, idleSince),
            lastDataTimestamp: now - (gap - 1),
            sinceLastProbeMs: gap,
          });
        }
        expect(onFire).not.toHaveBeenCalled();
      }
    );

    it("does not count output that predates the gap", () => {
      const { watchdog, onFire } = makeWatchdog({ validator });
      const gap = 15000;
      for (let i = 0; i < FAIL_THRESHOLD; i++) {
        const now = start + i * gap;
        watchdog.check(now, {
          ...deadProbe(now, idleSince),
          lastDataTimestamp: now - gap,
          sinceLastProbeMs: gap,
        });
      }
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("still decays: one burst of output stops vetoing and the watchdog fires", () => {
      const { watchdog, onFire } = makeWatchdog({ validator });
      const gap = 15000;
      const dataAt = start - 1;
      // Probe 0 sees the burst and vetoes; the next FAIL_THRESHOLD are dead votes.
      for (let i = 0; i <= FAIL_THRESHOLD; i++) {
        expect(onFire).not.toHaveBeenCalled();
        const now = start + i * gap;
        watchdog.check(now, {
          ...deadProbe(now, idleSince),
          lastDataTimestamp: dataAt,
          sinceLastProbeMs: gap,
        });
      }
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("clears accumulated dead votes when a re-timed probe covers earlier output", () => {
      // Two dead votes, then saving→active re-times the timer: output at t+1s,
      // next probe 14s after the last one. The 5s TTL alone would miss it.
      const { watchdog, onFire } = makeWatchdog({ validator });
      watchdog.check(start, deadProbe(start, idleSince));
      watchdog.check(start + 5000, deadProbe(start + 5000, idleSince));
      const now = start + 19000;
      watchdog.check(now, {
        ...deadProbe(now, idleSince),
        lastDataTimestamp: start + 6000,
        sinceLastProbeMs: 14000,
      });
      watchdog.check(now + 5000, deadProbe(now + 5000, idleSince));
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  describe("TTL boundary for lastDataTimestamp veto", () => {
    it("data exactly at the TTL boundary does NOT veto (strict <)", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      // lastDataTimestamp at start - TTL_MS → now - lastDataTimestamp = TTL_MS (not < TTL).
      // Also must satisfy lastDataTimestamp > idleSince. With idleSince=1000 and TTL=5000,
      // lastDataTimestamp = start - TTL = 596000 which is > 1000.
      const probe = (now: number, dataAt: number): WaitingWatchdogProbeInputs => ({
        ...deadProbe(now, idleSince),
        lastDataTimestamp: dataAt,
      });
      watchdog.check(start, probe(start, start - TTL_MS));
      watchdog.check(start + 5000, probe(start + 5000, start + 5000 - TTL_MS));
      watchdog.check(start + 10000, probe(start + 10000, start + 10000 - TTL_MS));
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("data 1ms inside the TTL boundary DOES veto", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator });

      const idleSince = 1000;
      const start = idleSince + SILENCE_MS;
      const probe = (now: number, dataAt: number): WaitingWatchdogProbeInputs => ({
        ...deadProbe(now, idleSince),
        lastDataTimestamp: dataAt,
      });
      watchdog.check(start, probe(start, start - TTL_MS + 1));
      watchdog.check(start + 5000, probe(start + 5000, start + 5000 - TTL_MS + 1));
      watchdog.check(start + 10000, probe(start + 10000, start + 10000 - TTL_MS + 1));
      expect(onFire).not.toHaveBeenCalled();
    });
  });

  describe("custom failThreshold", () => {
    it("clamps to 1 — fires on the first dead tick", () => {
      const validator: ProcessStateValidator = { hasActiveChildren: () => false };
      const { watchdog, onFire } = makeWatchdog({ validator, failThreshold: 1 });

      const idleSince = 1000;
      const now = idleSince + SILENCE_MS;
      watchdog.check(now, deadProbe(now, idleSince));
      expect(onFire).toHaveBeenCalledTimes(1);
    });
  });
});
