import { describe, it, expect, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import {
  computeGrowthKbPerHour,
  isPlateau,
  evaluateTerminal,
  createLeakState,
  MEMORY_HISTORY_SIZE,
  STARTUP_SKIP_SAMPLES,
  CONSECUTIVE_REQUIRED,
  MIN_MEMORY_KB,
  MIN_SLOPE_KB_PER_HOUR,
  ALERT_COOLDOWN_MS,
  buildLeakActions,
  type LeakPoint,
  type LeakState,
} from "../useMemoryLeakDetection";

const T0 = 1_700_000_000_000;
const NOMINAL_MS = 2_500;
const SLOW_MS = 15_000;
const BASE_KB = MIN_MEMORY_KB + 100_000;
const SECONDS_PER_HOUR = 3_600;
// Observation 30 is the first past startup and counts as the first rise.
const ALERT_OBSERVATION = STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED - 1;

// A reading of a leak growing at a constant rate: it depends on when the reading
// was taken, never on how many readings came before it.
function leakAt(kbPerSecond: number, elapsedMs: number, startKb = BASE_KB): LeakPoint {
  return { memoryKb: startKb + (kbPerSecond * elapsedMs) / 1000, sampledAt: T0 + elapsedMs };
}

function schedule(intervalsMs: number[], count: number): number[] {
  const elapsed = [0];
  for (let i = 1; i < count; i++) {
    elapsed.push(elapsed[i - 1]! + intervalsMs[(i - 1) % intervalsMs.length]!);
  }
  return elapsed;
}

function firstAlert(
  kbPerSecond: number,
  elapsedMs: number[]
): { observation: number; kbPerHour: number } | null {
  const state = createLeakState();
  for (let i = 0; i < elapsedMs.length; i++) {
    if (evaluateTerminal(leakAt(kbPerSecond, elapsedMs[i]!), state, T0)) {
      return { observation: i + 1, kbPerHour: computeGrowthKbPerHour(state.history) };
    }
  }
  return null;
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

  // Readings taken up to and including the one that alerts; 0 if none does.
  stepsToAlert(deltaKb: number, max: number): number {
    for (let i = 1; i <= max; i++) {
      if (this.step(deltaKb)) return i;
    }
    return 0;
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

  it("fits a line through every point rather than joining the endpoints", () => {
    // Offsets of 0, 0 and 14 KB at 0, 1 and 3 seconds: least squares gives
    // (3*42 - 4*14) / (3*10 - 4*4) = 5 KB/s; the endpoints alone would give 14/3.
    const points = [
      { memoryKb: BASE_KB, sampledAt: T0 },
      { memoryKb: BASE_KB, sampledAt: T0 + 1_000 },
      { memoryKb: BASE_KB + 14, sampledAt: T0 + 3_000 },
    ];
    expect(computeGrowthKbPerHour(points)).toBeCloseTo(5 * SECONDS_PER_HOUR, 6);
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

  it("reads a much lower rate when the pause had no growth in it", () => {
    const before = schedule([NOMINAL_MS], 15).map((ms) => leakAt(80, ms));
    const last = before[before.length - 1]!;
    // The first reading after the pause is exactly where the last one left off.
    const after = schedule([NOMINAL_MS], 15).map((ms) => ({
      memoryKb: last.memoryKb + (80 * ms) / 1000,
      sampledAt: last.sampledAt + 10 * 60_000 + ms,
    }));

    const stalled = computeGrowthKbPerHour([...before, ...after]);
    expect(stalled).toBeGreaterThan(0);
    expect(stalled).toBeLessThan((80 * SECONDS_PER_HOUR) / 4);
  });
});

describe("isPlateau", () => {
  function readings(offsetsKb: number[], gapMs: number): LeakPoint[] {
    return offsetsKb.map((offset, i) => ({
      memoryKb: BASE_KB + offset,
      sampledAt: T0 + i * gapMs,
    }));
  }

  it("returns true when recent values have range below threshold", () => {
    expect(isPlateau(readings([0, 10, 5, 15, 8], NOMINAL_MS))).toBe(true);
  });

  it("returns false when range exceeds threshold", () => {
    expect(isPlateau(readings([0, 800, 1_600, 2_400, 3_200], NOMINAL_MS))).toBe(false);
  });

  it("returns false with fewer than the window's worth of points", () => {
    expect(isPlateau([leakAt(0, 0), leakAt(0, NOMINAL_MS)])).toBe(false);
  });

  it("holds the 685 KB boundary over the nominal ten-second window", () => {
    expect(isPlateau(readings([0, 0, 0, 0, 684], NOMINAL_MS))).toBe(true);
    expect(isPlateau(readings([0, 0, 0, 0, 685], NOMINAL_MS))).toBe(false);
  });

  it("scales the allowance with the window's span, so slow polling allows proportionally more", () => {
    expect(isPlateau(readings([0, 0, 0, 0, 4_109], SLOW_MS))).toBe(true);
    expect(isPlateau(readings([0, 0, 0, 0, 4_110], SLOW_MS))).toBe(false);
  });

  it("measures the whole range of the window, not first against last", () => {
    expect(isPlateau(readings([0, 0, 800, 0, 0], NOMINAL_MS))).toBe(false);
  });

  it("stops counting an excursion once it has left the five-reading window", () => {
    const points = readings([0, 0, 800, 0, 0, 0, 0, 0], NOMINAL_MS);
    expect(isPlateau(points.slice(0, 7))).toBe(false);
    expect(isPlateau(points.slice(0, 8))).toBe(true);
  });
});

describe("startup suppression", () => {
  it("does not alert or count increases until the startup readings are past", () => {
    const run = new Run();
    for (let i = 0; i < STARTUP_SKIP_SAMPLES - 1; i++) {
      expect(run.step(500)).toBe(false);
    }
    expect(run.state.sampleCount).toBe(STARTUP_SKIP_SAMPLES - 1);
    expect(run.state.consecutiveIncreases).toBe(0);

    run.step(500);
    expect(run.state.consecutiveIncreases).toBe(1);
  });
});

describe("minimum memory gate", () => {
  it("does not alert when memory is below MIN_MEMORY_KB even with consecutive increases", () => {
    const run = new Run(MIN_MEMORY_KB - 100_000);
    expect(run.grow(STARTUP_SKIP_SAMPLES + CONSECUTIVE_REQUIRED + 5, 200)).toBe(false);
  });

  it("drops an established streak on a rising reading that is still below the floor", () => {
    const run = new Run(MIN_MEMORY_KB - 100_000);
    run.grow(STARTUP_SKIP_SAMPLES, 0);
    run.state.consecutiveIncreases = 7;

    // A rise that is large enough to clear the plateau gate too, so only the
    // floor can be what clears the streak.
    expect(run.step(800)).toBe(false);
    expect(run.state.consecutiveIncreases).toBe(0);
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

describe.each([
  ["2.5s polling", NOMINAL_MS, 1],
  ["15s polling", SLOW_MS, 6],
])("minimum slope gate (%s)", (_name, intervalMs, scale) => {
  // Per-poll deltas scale with the interval, so every fit is the same in KB/hour.
  it("does not alert on a recent climb whose fit over the whole history is positive but under the minimum", () => {
    // The last twenty readings rise fast enough to clear the plateau and streak
    // gates; the high stretch before them keeps the fit over all thirty low.
    const run = new Run(BASE_KB, intervalMs);
    run.grow(STARTUP_SKIP_SAMPLES - 11, 0);
    run.step(3_000 * scale);
    run.grow(9, 0);
    run.step(-3_000 * scale);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200 * scale)).toBe(false);
    expect(run.state.consecutiveIncreases).toBeGreaterThanOrEqual(CONSECUTIVE_REQUIRED);
    const fit = computeGrowthKbPerHour(run.state.history);
    expect(fit).toBeGreaterThan(0);
    expect(fit).toBeLessThan(MIN_SLOPE_KB_PER_HOUR);
  });

  it("alerts on the same climb once the history behind it is level", () => {
    const run = new Run(BASE_KB, intervalMs);
    run.grow(STARTUP_SKIP_SAMPLES, 0);

    expect(run.grow(CONSECUTIVE_REQUIRED + 5, 200 * scale)).toBe(true);
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

  it.each(Object.entries(schedules))(
    "alerts on the same observation at the same rate for identical growth per minute (%s polling)",
    (_name, elapsed) => {
      const alert = firstAlert(128, elapsed);
      expect(alert?.observation).toBe(ALERT_OBSERVATION);
      expect(alert?.kbPerHour).toBeCloseTo(128 * SECONDS_PER_HOUR, 3);
    }
  );

  it.each(Object.entries(schedules))(
    "stays quiet for identical slow growth per minute (%s polling)",
    (_name, elapsed) => {
      expect(firstAlert(32, elapsed)).toBeNull();
    }
  );

  it.each(Object.entries(schedules))(
    "keeps growth between the slope and plateau limits quiet at any cadence (%s polling)",
    (_name, elapsed) => {
      // 216,000 KB/hour clears the slope gate (197,280) but not the plateau
      // allowance (246,600).
      expect(firstAlert(60, elapsed)).toBeNull();
    }
  );

  it("alerts at the same rate through a pause inside the window it fits", () => {
    const pause = 10 * 60_000;
    // The pause falls between observations 40 and 41, so the window behind the
    // first alert (observations 20-49) spans it, and the leak kept growing.
    const paused = schedule([NOMINAL_MS], SAMPLES).map((ms, i) => (i >= 40 ? ms + pause : ms));

    const alert = firstAlert(128, paused);
    expect(alert?.observation).toBe(ALERT_OBSERVATION);
    expect(alert?.kbPerHour).toBeCloseTo(128 * SECONDS_PER_HOUR, 3);
  });
});

describe("history window", () => {
  it("keeps only the most recent MEMORY_HISTORY_SIZE readings", () => {
    const run = new Run();
    run.grow(40, 300);

    expect(run.state.history).toHaveLength(MEMORY_HISTORY_SIZE);
    expect(run.state.history[0]!.sampledAt).toBe(T0 + (40 - MEMORY_HISTORY_SIZE + 1) * NOMINAL_MS);
  });
});

describe("sample ordering", () => {
  // 300 KB per 2.5s clears the plateau gate, so forty readings leave a streak.
  function runWithStreak(): Run {
    const run = new Run();
    run.grow(40, 300);
    expect(run.state.consecutiveIncreases).toBeGreaterThan(0);
    return run;
  }

  it("ignores a second reading from the same instant without touching the state", () => {
    const run = runWithStreak();
    const before = structuredClone(run.state);

    const repeated = evaluateTerminal(
      { memoryKb: run.kb + 50_000, sampledAt: run.at },
      run.state,
      run.now
    );

    expect(repeated).toBe(false);
    expect(run.state).toEqual(before);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "ignores a reading whose timestamp is %s without touching the state",
    (sampledAt) => {
      const run = runWithStreak();
      const before = structuredClone(run.state);

      expect(evaluateTerminal({ memoryKb: run.kb + 300, sampledAt }, run.state, run.now)).toBe(
        false
      );
      expect(run.state).toEqual(before);
    }
  );

  it("starts the history over when time runs backwards, keeping mute and cooldown", () => {
    const run = runWithStreak();
    run.state.dismissed = true;
    run.state.lastAlertAt = 12_345;
    const incoming = { memoryKb: BASE_KB, sampledAt: run.at - 60 * 60_000 };

    evaluateTerminal(incoming, run.state, run.now);

    expect(run.state.sampleCount).toBe(1);
    expect(run.state.history).toEqual([incoming]);
    expect(run.state.consecutiveIncreases).toBe(0);
    expect(run.state.dismissed).toBe(true);
    expect(run.state.lastAlertAt).toBe(12_345);
  });

  it("warms up and alerts afresh from readings taken after a clock step back", () => {
    const run = runWithStreak();
    run.at -= 60 * 60_000;

    // The step back is observation 1 of the new history: nothing carries over
    // from the streak that was building, so the alert lands where a new
    // terminal's would.
    expect(run.stepsToAlert(300, 100)).toBe(ALERT_OBSERVATION);
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
