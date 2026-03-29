import { describe, it, expect } from "vitest";
import {
  computeSlope,
  isPlateau,
  evaluateTerminal,
  createLeakState,
  STARTUP_SKIP_SAMPLES,
  CONSECUTIVE_REQUIRED,
  MIN_MEMORY_KB,
  MIN_SLOPE_KB_PER_SAMPLE,
  ALERT_COOLDOWN_MS,
  PLATEAU_RANGE_THRESHOLD_KB,
  type LeakState,
} from "../useMemoryLeakDetection";

function feedSamples(
  state: LeakState,
  samples: number[],
  now: number = Date.now()
): { alert: boolean; autoRestart: boolean; autoRestartThresholdKb: number } {
  let result = { alert: false, autoRestart: false, autoRestartThresholdKb: 0 };
  for (const sample of samples) {
    result = evaluateTerminal(sample, state, now);
  }
  return result;
}

describe("computeSlope", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(computeSlope([])).toBe(0);
    expect(computeSlope([100])).toBe(0);
  });

  it("computes positive slope for increasing values", () => {
    const values = Array.from({ length: 10 }, (_, i) => 1000 + i * 200);
    const slope = computeSlope(values);
    expect(slope).toBeCloseTo(200, 0);
  });

  it("computes zero slope for constant values", () => {
    const values = Array.from({ length: 10 }, () => 500);
    expect(computeSlope(values)).toBeCloseTo(0, 5);
  });
});

describe("isPlateau", () => {
  it("returns true when recent values have range below threshold", () => {
    const base = 600_000;
    const values = [base, base + 10, base + 5, base + 15, base + 8];
    expect(isPlateau(values)).toBe(true);
  });

  it("returns false when range exceeds threshold", () => {
    const base = 600_000;
    const step = PLATEAU_RANGE_THRESHOLD_KB + 100;
    const values = [base, base + step, base + step * 2, base + step * 3, base + step * 4];
    expect(isPlateau(values)).toBe(false);
  });

  it("returns false with fewer than PLATEAU_WINDOW values", () => {
    expect(isPlateau([1000, 1001])).toBe(false);
  });
});

describe("startup suppression", () => {
  it("does not alert during first STARTUP_SKIP_SAMPLES samples regardless of growth", () => {
    const state = createLeakState();
    const baseMem = MIN_MEMORY_KB + 10_000;
    for (let i = 0; i < STARTUP_SKIP_SAMPLES - 1; i++) {
      const result = evaluateTerminal(baseMem + i * 500, state, Date.now());
      expect(result.alert).toBe(false);
    }
    expect(state.sampleCount).toBe(STARTUP_SKIP_SAMPLES - 1);
  });
});

describe("minimum memory gate", () => {
  it("does not alert when memory is below MIN_MEMORY_KB even with consecutive increases", () => {
    const state = createLeakState();
    // Skip past startup
    const smallMem = MIN_MEMORY_KB - 100_000;
    const samples = Array.from(
      { length: STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5 },
      (_, i) => smallMem + i * 200
    );
    const result = feedSamples(state, samples);
    expect(result.alert).toBe(false);
  });
});

describe("plateau gate", () => {
  it("resets consecutive counter when values plateau", () => {
    const state = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;

    // Skip startup
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) {
      evaluateTerminal(baseMem, state, Date.now());
    }

    // 15 consecutive increases
    for (let i = 0; i < 15; i++) {
      evaluateTerminal(baseMem + (i + 1) * 500, state, Date.now());
    }
    expect(state.consecutiveIncreases).toBeGreaterThan(0);

    // Then plateau — 5 values with range < PLATEAU_RANGE_THRESHOLD_KB
    const plateauVal = baseMem + 15 * 500;
    for (let i = 0; i < 5; i++) {
      evaluateTerminal(plateauVal + i * 10, state, Date.now());
    }
    expect(state.consecutiveIncreases).toBe(0);
  });
});

describe("minimum slope gate", () => {
  it("does not alert when slope is below threshold despite consecutive increases", () => {
    const state = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;

    // Skip startup with constant value
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) {
      evaluateTerminal(baseMem, state, Date.now());
    }

    // Very slow growth — 1 KB per sample (well below MIN_SLOPE_KB_PER_SAMPLE of 137)
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const result = evaluateTerminal(baseMem + (i + 1) * 1, state, Date.now());
      expect(result.alert).toBe(false);
    }
  });
});

describe("happy path — fires alert", () => {
  it("alerts after consecutive increases past startup with sufficient slope and memory", () => {
    const state = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;
    const now = Date.now();

    // Skip startup
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) {
      evaluateTerminal(baseMem, state, now);
    }

    // Fast consecutive increases — 200 KB per sample (above MIN_SLOPE_KB_PER_SAMPLE)
    let alerted = false;
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const result = evaluateTerminal(baseMem + (i + 1) * 200, state, now);
      if (result.alert) {
        alerted = true;
        break;
      }
    }
    expect(alerted).toBe(true);
  });
});

describe("cooldown", () => {
  it("suppresses second alert within cooldown period", () => {
    const state = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;
    const now = Date.now();

    // Skip startup
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) {
      evaluateTerminal(baseMem, state, now);
    }

    // Trigger first alert
    let firstAlertAt = 0;
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const result = evaluateTerminal(baseMem + (i + 1) * 200, state, now);
      if (result.alert) {
        state.lastAlertAt = now;
        firstAlertAt = now;
        break;
      }
    }
    expect(firstAlertAt).toBe(now);

    // Try to trigger again within cooldown — should not alert
    const shortlyAfter = now + 1000;
    state.consecutiveIncreases = 0;
    const highMem = baseMem + 200_000;
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const result = evaluateTerminal(highMem + (i + 1) * 200, state, shortlyAfter);
      expect(result.alert).toBe(false);
    }
  });

  it("allows alert after cooldown expires", () => {
    const state = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;
    const now = Date.now();

    // Skip startup
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) {
      evaluateTerminal(baseMem, state, now);
    }

    // First alert
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const result = evaluateTerminal(baseMem + (i + 1) * 200, state, now);
      if (result.alert) {
        state.lastAlertAt = now;
        break;
      }
    }

    // After cooldown
    const afterCooldown = now + ALERT_COOLDOWN_MS + 1;
    state.consecutiveIncreases = 0;
    const highMem = baseMem + 200_000;
    let alertedAgain = false;
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const result = evaluateTerminal(highMem + (i + 1) * 200, state, afterCooldown);
      if (result.alert) {
        alertedAgain = true;
        break;
      }
    }
    expect(alertedAgain).toBe(true);
  });
});

describe("dismiss", () => {
  it("suppresses all alerts when dismissed", () => {
    const state = createLeakState();
    state.dismissed = true;
    const baseMem = MIN_MEMORY_KB + 100_000;

    const samples = Array.from(
      { length: STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5 },
      (_, i) => baseMem + i * 200
    );
    const result = feedSamples(state, samples);
    expect(result.alert).toBe(false);
  });
});

describe("cleanup on terminal removal", () => {
  it("state is independent per terminal (no cross-contamination)", () => {
    const state1 = createLeakState();
    const state2 = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;
    const now = Date.now();

    // State1 gets full growth pattern
    for (let i = 0; i < STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5; i++) {
      evaluateTerminal(baseMem + i * 200, state1, now);
    }
    expect(state1.consecutiveIncreases).toBeGreaterThan(0);

    // State2 is fresh
    expect(state2.consecutiveIncreases).toBe(0);
    expect(state2.sampleCount).toBe(0);
  });
});

describe("multiple terminals", () => {
  it("tracks independent detection state per terminal", () => {
    const stateA = createLeakState();
    const stateB = createLeakState();
    const baseMem = MIN_MEMORY_KB + 100_000;
    const now = Date.now();

    // Terminal A: startup + growth → should alert
    for (let i = 0; i < STARTUP_SKIP_SAMPLES; i++) {
      evaluateTerminal(baseMem, stateA, now);
    }
    let aAlerted = false;
    for (let i = 0; i < CONSECUTIVE_REQUIRED + 5; i++) {
      const r = evaluateTerminal(baseMem + (i + 1) * 200, stateA, now);
      if (r.alert) aAlerted = true;
    }
    expect(aAlerted).toBe(true);

    // Terminal B: constant memory → should not alert
    for (let i = 0; i < STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5; i++) {
      const r = evaluateTerminal(baseMem, stateB, now);
      expect(r.alert).toBe(false);
    }
  });
});
