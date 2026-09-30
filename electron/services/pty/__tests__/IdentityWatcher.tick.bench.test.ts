// Benchmark for IdentityWatcher's 200 ms poll on a committed agent terminal.
// Writes metrics as JSON to $IDENTITY_WATCHER_BENCH_OUT when set; the
// assertions pin behavioural milestones (demotion tick, probe reads).
//
// Each scenario seeds `claude`, lets the fallback commit, then advances 1,000
// poll ticks against a fake delegate serving a ~4 KB ANSI-heavy forensics
// buffer. Wall time uses process.hrtime captured at import, before fake timers
// replace it. stripAnsi is wrapped to count calls, and separately the calls
// whose input carries an ESC (the ones that run the regex passes). Every tick
// records promptStreak, stopped and the delegate events (probe reads,
// detections); the trace hash is for comparing builds by hand, since the
// assertions only require it to be stable within one build. Timing stops once
// the watcher stops polling, so per-tick figures cover live ticks only.
//
// 1. idle: nothing changes — agent sits at its composer.
// 2. streaming: every tick brings new output, new viewport and cursor lines.
// 3. held-prompt: prompt-looking agent echo stays on screen while the probe
//    keeps finding the agent in the foreground (the gated-probe path).
// 4. demotion: idle, then the shell prompt returns and the agent is demoted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const { stripAnsiCalls } = vi.hoisted(() => ({ stripAnsiCalls: { count: 0, heavy: 0 } }));
// Fake timers replace process.hrtime; keep the real clock.
const hrtimeNs = process.hrtime.bigint.bind(process.hrtime);

vi.mock("../AgentPatternDetector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../AgentPatternDetector.js")>();
  return {
    ...actual,
    stripAnsi: (text: string) => {
      stripAnsiCalls.count += 1;
      if (text.includes("\x1b")) stripAnsiCalls.heavy += 1;
      return actual.stripAnsi(text);
    },
  };
});

import {
  FOREGROUND_PROBE_REFUTATION_MS,
  SHELL_IDENTITY_FALLBACK_COMMIT_MS,
  SHELL_IDENTITY_FALLBACK_POLL_MS,
  IdentityWatcher,
  type IdentityWatcherDelegate,
} from "../IdentityWatcher.js";

const TICKS = 1_000;
const HELD_PROMPT_PROBE_READS =
  (TICKS * SHELL_IDENTITY_FALLBACK_POLL_MS) / FOREGROUND_PROBE_REFUTATION_MS;
// One read on each of the two prompt ticks that demote.
const DEMOTION_PROBE_READS = 2;
const ROUNDS = 7;
const SHELL_PGID = 100;
const AGENT_PGID = 200;

interface State {
  detectedAgentId: string | undefined;
  lastOutputTime: number;
  visibleLines: string[];
  cursorLine: string | null;
  recentOutput: string;
  ptyDescendantCount: number | undefined;
  foregroundPgid: number;
  events: string[];
}

function ansiLine(i: number): string {
  return (
    `\x1b[2K\x1b[1G\x1b[38;2;215;119;87m●\x1b[39m \x1b[1mUpdate\x1b[22m(` +
    `\x1b[38;5;244msrc/module${i}.ts\x1b[39m)\x1b[0m \x1b[2m⎿ Updated with ${i % 7} additions\x1b[22m` +
    `\x1b]8;;file:///src/module${i}.ts\x07link\x1b]8;;\x07\x1b[K\r\n`
  );
}

function ansiBuffer(seed: number): string {
  let out = "";
  for (let i = seed; out.length < 4_600; i++) out += ansiLine(i);
  out += "\x1b[?25l\x1b[2K\x1b[1G\x1b[38;5;246m╭──────────────────────────╮\x1b[39m\r\n";
  out += "\x1b[2K\x1b[1G\x1b[38;5;246m│\x1b[39m > \x1b[7m \x1b[27m\x1b[38;5;246m│\x1b[39m\r\n";
  out += "\x1b[2K\x1b[1G  \x1b[2m? for shortcuts\x1b[22m\x1b[?25h";
  return out.slice(-4_000);
}

const COMPOSER_LINES = [
  "● Update(src/module9.ts)",
  "╭────────╮",
  "│ >      │",
  "  ? for shortcuts",
];

function createDelegate(state: State): IdentityWatcherDelegate {
  return {
    terminalId: "bench-term-12345678",
    isExited: false,
    wasKilled: false,
    get detectedAgentId() {
      return state.detectedAgentId;
    },
    get lastOutputTime() {
      return state.lastOutputTime;
    },
    spawnedAt: 1_000,
    lastDetectedProcessIconId: undefined,
    processDetector: null,
    getLastNLines: () => state.visibleLines,
    getCursorLine: () => state.cursorLine,
    getRecentOutput: () => state.recentOutput,
    getLastCommand: () => undefined,
    getPtyDescendantCount: () => state.ptyDescendantCount,
    readForegroundProcessGroupSnapshot: () => {
      state.events.push("probe");
      return { shellPgid: SHELL_PGID, foregroundPgid: state.foregroundPgid, sampledAt: Date.now() };
    },
    handleAgentDetection: (result) => {
      state.events.push(`detect:${result.detectionState}:${result.agentType ?? "-"}`);
      if (result.detectionState === "agent") state.detectedAgentId = result.agentType;
      else state.detectedAgentId = undefined;
    },
  };
}

type Scenario = "idle" | "streaming" | "held-prompt" | "demotion";

interface RunResult {
  usPerTick: number;
  stripAnsiPerTick: number;
  ansiStripsPerTick: number;
  traceHash: string;
  demotedAtTick: number | null;
  probeReads: number;
}

function runScenario(scenario: Scenario): RunResult {
  const state: State = {
    detectedAgentId: undefined,
    lastOutputTime: 0,
    visibleLines: [...COMPOSER_LINES],
    cursorLine: "│ >      │",
    recentOutput: ansiBuffer(0),
    ptyDescendantCount: 3,
    foregroundPgid: AGENT_PGID,
    events: [],
  };
  const watcher = new IdentityWatcher(createDelegate(state));
  watcher.seed("claude");
  // Commit and let the probe latch before measuring.
  vi.advanceTimersByTime(SHELL_IDENTITY_FALLBACK_COMMIT_MS + SHELL_IDENTITY_FALLBACK_POLL_MS * 5);
  expect(watcher.isFallbackCommitted).toBe(true);

  if (scenario === "held-prompt") {
    state.visibleLines = ["● Done", "", "user@host:~/repo $", ""];
    state.cursorLine = "user@host:~/repo $";
  }

  const internals = watcher as unknown as { promptStreak: number; stopped: boolean };
  const trace: string[] = [];
  let demotedAtTick: number | null = null;
  let elapsedNs = 0n;
  const startCalls = stripAnsiCalls.count;
  const startHeavy = stripAnsiCalls.heavy;
  const eventsAtStart = state.events.length;
  let liveTicks = 0;
  for (let tick = 0; tick < TICKS && !internals.stopped; tick++) {
    if (scenario === "streaming") {
      state.recentOutput = (state.recentOutput + ansiLine(tick)).slice(-4_000);
      state.lastOutputTime = Date.now();
      state.visibleLines = [`● Update(src/module${tick}.ts)`, ...COMPOSER_LINES.slice(1)];
      state.cursorLine = `│ > typing ${tick} │`;
    } else if (scenario === "demotion" && tick === 500) {
      state.recentOutput = (state.recentOutput + "\x1b[0m\r\nuser@host:~/repo $ ").slice(-4_000);
      state.visibleLines = ["● Done", "", "user@host:~/repo $", ""];
      state.cursorLine = "user@host:~/repo $";
      state.ptyDescendantCount = 0;
      state.foregroundPgid = SHELL_PGID;
    }
    const eventsBefore = state.events.length;
    const t0 = hrtimeNs();
    vi.advanceTimersByTime(SHELL_IDENTITY_FALLBACK_POLL_MS);
    elapsedNs += hrtimeNs() - t0;
    liveTicks += 1;
    const newEvents = state.events.slice(eventsBefore).join(",");
    trace.push(`${tick}|${internals.promptStreak}|${internals.stopped}|${newEvents}`);
    if (demotedAtTick === null && newEvents.includes("detect:no_agent")) demotedAtTick = tick;
  }
  const calls = stripAnsiCalls.count - startCalls;
  const heavy = stripAnsiCalls.heavy - startHeavy;
  const probeReads = state.events.slice(eventsAtStart).filter((e) => e === "probe").length;
  watcher.dispose();
  return {
    usPerTick: Number(elapsedNs) / 1_000 / liveTicks,
    stripAnsiPerTick: calls / liveTicks,
    ansiStripsPerTick: heavy / liveTicks,
    traceHash: createHash("sha256").update(trace.join("\n")).digest("hex").slice(0, 16),
    demotedAtTick,
    probeReads,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("IdentityWatcher poll tick benchmark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("measures per-tick cost and pins the verdict trace", () => {
    const scenarios: Scenario[] = ["idle", "streaming", "held-prompt", "demotion"];
    for (const s of scenarios) runScenario(s); // warm-up
    const report: Record<string, unknown> = {};
    for (const s of scenarios) {
      const runs = Array.from({ length: ROUNDS }, () => runScenario(s));
      const hashes = new Set(runs.map((r) => r.traceHash));
      expect(hashes.size).toBe(1);
      report[s] = {
        usPerTickMedian: Number(median(runs.map((r) => r.usPerTick)).toFixed(2)),
        usPerTickMin: Number(Math.min(...runs.map((r) => r.usPerTick)).toFixed(2)),
        stripAnsiPerTick: runs[0].stripAnsiPerTick,
        ansiStripsPerTick: runs[0].ansiStripsPerTick,
        traceHash: runs[0].traceHash,
        demotedAtTick: runs[0].demotedAtTick,
        probeReads: runs[0].probeReads,
      };
    }

    const milestones = Object.fromEntries(
      scenarios.map((s) => {
        const r = report[s] as { demotedAtTick: number | null; probeReads: number };
        return [s, [r.demotedAtTick, r.probeReads]];
      })
    );
    // The prompt returns at tick 500 and takes two prompt polls to demote. A
    // stable agent never reads the latched probe; held prompt-looking output
    // re-asks once per refutation window.
    expect(milestones).toEqual({
      idle: [null, 0],
      streaming: [null, 0],
      "held-prompt": [null, HELD_PROMPT_PROBE_READS],
      demotion: [501, DEMOTION_PROBE_READS],
    });

    if (process.env.IDENTITY_WATCHER_BENCH_OUT) {
      writeFileSync(process.env.IDENTITY_WATCHER_BENCH_OUT, JSON.stringify(report, null, 2));
    }
  });
});
