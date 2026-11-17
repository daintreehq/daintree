import { describe, it, expect, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import {
  computeGrowthKbPerHour,
  isPlateau,
  evaluateTerminal,
  createLeakState,
  STARTUP_SKIP_SAMPLES,
  CONSECUTIVE_REQUIRED,
  MIN_MEMORY_KB,
  ALERT_COOLDOWN_MS,
  buildLeakActions,
  type LeakPoint,
  type LeakState,
} from "../useMemoryLeakDetection";

const T0 = 1_700_000_000_000;
const NOMINAL_MS = 2_500;
const BASE_KB = MIN_MEMORY_KB + 100_000;
const SECONDS_PER_HOUR = 3_600;

// Sample n of a leak growing at a constant rate: the reading depends on when it
// was taken, never on how many readings came before it.
function leakAt(kbPerSecond: number, elapsedMs: number, startKb = BASE_KB): LeakPoint {
  return { memoryKb: startKb + (kbPerSecond * elapsedMs) / 1000, sampledAt: T0 + elapsedMs };
}

function schedule(intervalsMs: number[], count: number): number[] {
  const elapsed = [0];
  for (let i = 1; i < count; i++)
    elapsed.push(elapsed[i - 1]! + intervalsMs[(i - 1) % intervalsMs.length]!);
  return elapsed;
}

function firstAlert(kbPerSecond: number, elapsedMs: number[], now = T0): number {
  const state = createLeakState();
  for (let i = 0; i < elapsedMs.length; i++) {
    if (evaluateTerminal(leakAt(kbPerSecond, elapsedMs[i]!), state, now)) return i + 1;
  }
  return 0;
}

// One terminal's readings, taken every `intervalMs` of sampling time; `now` is
// the renderer clock the cooldown reads, advanced separately.
class Run {
  state: LeakState = createLeakState();
  at = T0;
  now = T0;

  constructor(
    public kb = BASE_KB,
    private intervalMs = NOMINAL_MS
  ) {}

  step(deltaKb: number): boolean {
    this.at += this.intervalMs;
    this.kb += deltaKb;
    return evaluateTerminal({ memoryKb: this.kb, sampledAt: this.at }, this.state, this.now);
  }

  grow(count: number, deltaKb: number): boolean {
    for (let i = 0; i < count; i++) {
      if (this.step(deltaKb)) return true;
    }
    return false;
  }
}

describe("computeGrowthKbPerHour", () => {
  it("returns 0 for fewer than 2 points", () => {
    expect(computeGrowthKbPerHour([])).toBe(0);
    expect(computeGrowthKbPerHour([leakAt(10, 0)])).toBe(0);
  });

  it("returns 0 when every point shares one timestamp", () => {
    const points = [1000, 2000, 3000].map((memoryKb) => ({ memoryKb, sampledAt: T0 }));
    expect(computeGrowthKbPerHour(points)).toBe(0);
  });

  it("converts growth per second to KB per hour", () => {
    const points = schedule([NOMINAL_MS], 10).map((ms) => leakAt(80, ms));
    expect(computeGrowthKbPerHour(points)).toBeCloseTo(80 * SECONDS_PER_HOUR, 3);
  });

  it("computes zero for constant values", () => {
    const points = schedule([NOMINAL_MS], 10).map((ms) => leakAt(0, ms));
    expect(computeGrowthKbPerHour(points)).toBeCloseTo(0, 5);
  });

  it("reads the same series at the same rate whatever the polling interval", () => {
    const expected = 80 * SECONDS_PER_HOUR;
    const schedules = {
      fast: [2_500],
      slow: [15_000],
      irregular: [2_500, 15_000, 4_000, 9_000, 2_500],
    };
    for (const intervals of Object.values(schedules)) {
      const points = schedule(intervals, 30).map((ms) => leakAt(80, ms));
      expect(computeGrowthKbPerHour(points)).toBeCloseTo(expected, 3);
    }
  });

  it("does not read the same per-poll increase at six times the rate when polls are six times apart", () => {
    const perPoll = (intervalMs: number) =>
      computeGrowthKbPerHour(
        Array.from({ length: 20 }, (_, i) => ({
          memoryKb: BASE_KB + i * 200,
          sampledAt: T0 + i * intervalMs,
        }))
      );
    expect(perPoll(2_500) / perPoll(15_000)).toBeCloseTo(6, 5);
  });

  it("keeps the rate across a pause in which the leak kept growing", () => {
    const elapsed = [...schedule([NOMINAL_MS], 15)];
    const resumeAt = elapsed[elapsed.length - 1]! + 10 * 60_000;
    for (let i = 0; i < 15; i++) elapsed.push(resumeAt + i * NOMINAL_MS);

    const points = elapsed.map((ms) => leakAt(80, ms));
    expect(computeGrowthKbPerHour(points)).toBeCloseTo(80 * SECONDS_PER_HOUR, 3);
  });

  it("reads a lower rate when the pause had no growth in it", () => {
    const before = schedule([NOMINAL_MS], 15).map((ms) => leakAt(80, ms));
    const last = before[before.length - 1]!;
    const after = schedule([NOMINAL_MS], 15).map((ms) => ({
      memoryKb: last.memoryKb + NOMINAL_MS * 0.08 + (80 * ms) / 1000,
      sampledAt: last.sampledAt + 10 * 60_000 + ms,
    }));

    const steady = 80 * SECONDS_PER_HOUR;
    expect(computeGrowthKbPerHour([...before, ...after])).toBeLessThan(steady / 2);
  });
});

describe("isPlateau", () => {
  function windowSpanning(spanMs: number, rangeKb: number): LeakPoint[] {
    const gap = spanMs / 4;
    return [0, 1, 2, 3, 4].map((i) => ({
      memoryKb: BASE_KB + (i === 4 ? rangeKb : 0),
      sampledAt: T0 + i * gap,
    }));
  }

  it("returns true when recent values have range below threshold", () => {
    const points = [0, 10, 5, 15, 8].map((d, i) => ({
      memoryKb: BASE_KB + d,
      sampledAt: T0 + i * NOMINAL_MS,
    }));
    expect(isPlateau(points)).toBe(true);
  });

  it("returns false when range exceeds threshold", () => {
    const points = [0, 1, 2, 3, 4].map((i) => ({
      memoryKb: BASE_KB + i * 800,
      sampledAt: T0 + i * NOMINAL_MS,
    }));
    expect(isPlateau(points)).toBe(false);
  });

  it("returns false with fewer than the window's worth of points", () => {
    expect(isPlateau([leakAt(0, 0), leakAt(0, NOMINAL_MS)])).toBe(false);
  });

  it("holds the 685 KB boundary over the nominal ten-second window", () => {
    expect(isPlateau(windowSpanning(10_000, 684))).toBe(true);
    expect(isPlateau(windowSpanning(10_000, 685))).toBe(false);
  });

  it("scales the allowance with the window's span, so slow polling allows proportionally more", () => {
    expect(isPlateau(windowSpanning(60_000, 4_109))).toBe(true);
    expect(isPlateau(windowSpanning(60_000, 4_110))).toBe(false);
  });
});

describe("startup suppression", () => {
  it("does not alert during first STARTUP_SKIP_SAMPLES samples regardless of growth", () => {
    const run = new Run();
    for (let i = 0; i < STARTUP_SKIP_SAMPLES - 1; i++) {
      expect(run.step(500)).toBe(false);
    }
    expect(run.state.sampleCount).toBe(STARTUP_SKIP_SAMPLES - 1);
  });
});

describe("minimum memory gate", () => {
  it("does not alert when memory is below MIN_MEMORY_KB even with consecutive increases", () => {
    const run = new Run(MIN_MEMORY_KB - 100_000);
    expect(run.grow(STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5, 200)).toBe(false);
  });
});

describe("plateau gate", () => {
  it("resets consecutive counter when values plateau", () => {
    const run = new Run();
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    run.grow(15, 500);
    expect(run.state.consecutiveIncreases).toBeGreaterThan(0);

    // Five readings 10 KB apart: a range well under what the minimum rate would
    // cover in the ten seconds they span.
    run.grow(5, 10);
    expect(run.state.consecutiveIncreases).toBe(0);
  });
});

describe("minimum slope gate", () => {
  it("does not alert on a recent climb whose fit over the whole history is below the threshold", () => {
    // The last twenty readings rise fast enough to clear the plateau and streak
    // gates, but a high stretch before them drags the fitted slope under.
    const run = new Run();
    run.grow(STARTUP_SKIP_SAMPLES - 11, 0);
    run.step(20_000);
    run.grow(9, 0);
    run.step(-20_000);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(false);
    expect(run.state.consecutiveIncreases).toBeGreaterThanOrEqual(CONSECUTIVE_REQUIRED);
  });

  it("alerts on the same climb once the history behind it is level", () => {
    const run = new Run();
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(true);
  });
});

describe("happy path — fires alert", () => {
  it("alerts after consecutive increases past startup with sufficient slope and memory", () => {
    const run = new Run();
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    // 200 KB per 2.5s is 288,000 KB/hour, above the minimum rate.
    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(true);
  });
});

describe("polling interval independence", () => {
  const SAMPLES = 70;
  const schedules = {
    fast: schedule([2_500], SAMPLES),
    slow: schedule([15_000], SAMPLES),
    irregular: schedule([2_500, 15_000, 4_000, 2_500, 9_000, 15_000, 3_000], SAMPLES),
  };
  // Observation 30 is the first past startup and counts as the first rise.
  const ALERT_OBSERVATION = STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED - 1;

  it.each(Object.entries(schedules))(
    "alerts on the same observation for identical growth per minute (%s polling)",
    (_name, elapsed) => {
      expect(firstAlert(128, elapsed)).toBe(ALERT_OBSERVATION);
    }
  );

  it.each(Object.entries(schedules))(
    "stays quiet for identical slow growth per minute (%s polling)",
    (_name, elapsed) => {
      expect(firstAlert(32, elapsed)).toBe(0);
    }
  );

  it.each(Object.entries(schedules))(
    "keeps growth between the slope and plateau limits quiet at any cadence (%s polling)",
    (_name, elapsed) => {
      // 216,000 KB/hour clears the slope gate (197,280) but not the plateau
      // allowance (246,600).
      expect(firstAlert(60, elapsed)).toBe(0);
    }
  );

  it("alerts through a pause in which the leak kept growing", () => {
    const elapsed = schedule([NOMINAL_MS], SAMPLES);
    const pause = 10 * 60_000;
    const paused = elapsed.map((ms, i) => (i >= 12 ? ms + pause : ms));

    expect(firstAlert(128, paused)).toBe(ALERT_OBSERVATION);
  });
});

describe("sample ordering", () => {
  it("ignores a second reading from the same instant without touching the state", () => {
    const run = new Run();
    run.grow(40, 100);
    const before = structuredClone(run.state);

    const repeated = evaluateTerminal(
      { memoryKb: run.kb + 50_000, sampledAt: run.at },
      run.state,
      run.now
    );

    expect(repeated).toBe(false);
    expect(run.state).toEqual(before);
  });

  it("ignores a reading with no usable timestamp", () => {
    const state = createLeakState();
    expect(evaluateTerminal({ memoryKb: BASE_KB, sampledAt: Number.NaN }, state, T0)).toBe(false);
    expect(state.sampleCount).toBe(0);
    expect(state.history).toEqual([]);
  });

  it("starts the history over when time runs backwards, keeping mute and cooldown", () => {
    const run = new Run();
    run.state.dismissed = true;
    run.state.lastAlertAt = 12_345;
    run.grow(40, 300);

    evaluateTerminal({ memoryKb: BASE_KB, sampledAt: run.at - 60 * 60_000 }, run.state, run.now);

    expect(run.state.sampleCount).toBe(1);
    expect(run.state.history).toHaveLength(1);
    expect(run.state.consecutiveIncreases).toBe(0);
    expect(run.state.dismissed).toBe(true);
    expect(run.state.lastAlertAt).toBe(12_345);
  });

  it("can alert again from readings taken after a clock step back", () => {
    const run = new Run();
    run.grow(10, 300);
    run.at -= 60 * 60_000;
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(true);
  });
});

describe("cooldown", () => {
  it("suppresses second alert within cooldown period", () => {
    const run = new Run();
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(true);
    run.state.lastAlertAt = run.now;

    // The streak and slope still qualify; only the cooldown holds it back.
    run.now += 1000;
    expect(run.state.consecutiveIncreases).toBeGreaterThanOrEqual(CONSECUTIVE_REQUIRED);
    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(false);
  });

  it("allows alert after cooldown expires", () => {
    const run = new Run();
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(true);
    run.state.lastAlertAt = run.now;

    run.now += ALERT_COOLDOWN_MS + 1;
    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200)).toBe(true);
  });
});

describe("dismiss", () => {
  it("suppresses all alerts when dismissed", () => {
    const run = new Run();
    run.state.dismissed = true;

    expect(run.grow(STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5, 200)).toBe(false);
  });
});

describe("buildLeakActions", () => {
  it("makes the Settings button open Terminal → Performance when clicked", () => {
    dispatch.mockClear();
    const settings = buildLeakActions("t1", () => {}).find((a) => a.label === "Settings")!;
    settings.onClick();
    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "terminal", subtab: "performance" },
      { source: "user" }
    );
  });
});
