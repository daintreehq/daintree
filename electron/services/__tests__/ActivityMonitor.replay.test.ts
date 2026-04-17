import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadExpected,
  matchTransitions,
  replayCast,
  type ExpectedTransition,
  type RecordedTransition,
  type ReplayCastOpts,
} from "./replay/castReplayHarness.js";
import type { ProcessStateValidator } from "../ActivityMonitor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "activity-monitor");

function fixture(name: string) {
  return {
    cast: path.join(FIXTURE_DIR, `${name}.cast`),
    expected: path.join(FIXTURE_DIR, `${name}.expected.json`),
  };
}

interface ReplayCase {
  name: string;
  agentId?: string;
  pollingMaxBootMs?: number;
}

const REPLAY_CASES: ReplayCase[] = [
  { name: "claude-normal-turn", agentId: "claude" },
  { name: "gemini-working-to-idle", agentId: "gemini" },
  { name: "codex-completion", agentId: "codex" },
  { name: "claude-silence-after-busy", agentId: "claude" },
];

describe("ActivityMonitor replay harness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  describe.each(REPLAY_CASES)("$name (no fragmentation)", ({ name, agentId, pollingMaxBootMs }) => {
    it("produces the expected transition sequence", async () => {
      const { cast, expected } = fixture(name);
      const expectedFile = loadExpected(expected);
      const opts: ReplayCastOpts = {
        agentId: expectedFile.agentId ?? agentId,
        settleMs: expectedFile.settleMs,
        pollingMaxBootMs: expectedFile.pollingMaxBootMs ?? pollingMaxBootMs,
        maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
        idleDebounceMs: expectedFile.idleDebounceMs,
        promptFastPathMinQuietMs: expectedFile.promptFastPathMinQuietMs,
      };
      const recorded = await replayCast(cast, opts);
      const failures = matchTransitions(recorded, expectedFile.transitions, {
        toleranceMs: expectedFile.toleranceMs ?? 200,
        allowExtraTransitions: expectedFile.allowExtraTransitions ?? false,
      });
      expect(failures, formatFailures(failures, recorded)).toHaveLength(0);
    });
  });

  describe.each([
    { name: "claude-normal-turn", agentId: "claude", seed: 12345 },
    { name: "claude-normal-turn", agentId: "claude", seed: 99999 },
    { name: "gemini-working-to-idle", agentId: "gemini", seed: 42 },
  ])("$name fragmented (seed=$seed)", ({ name, agentId, seed }) => {
    it("preserves the expected state sequence under chunk-boundary fragmentation", async () => {
      const { cast, expected } = fixture(name);
      const expectedFile = loadExpected(expected);
      const recorded = await replayCast(cast, {
        agentId: expectedFile.agentId ?? agentId,
        settleMs: expectedFile.settleMs,
        pollingMaxBootMs: expectedFile.pollingMaxBootMs,
        maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
        idleDebounceMs: expectedFile.idleDebounceMs,
        promptFastPathMinQuietMs: expectedFile.promptFastPathMinQuietMs,
        fragmentation: { seed, maxSplits: 4 },
      });
      // Fragmented playback exercises chunk-boundary parsing in xterm. The
      // state SEQUENCE is the load-bearing invariant: the monitor must reach
      // each expected state in order. Exact timing drifts a few hundred ms
      // because spinner-windowing thresholds depend on byte boundaries, and
      // chunk boundaries can introduce extra busy/completed pulses — those
      // are tolerated via allowExtraTransitions=true.
      const failures = matchTransitions(recorded, expectedFile.transitions, {
        toleranceMs: expectedFile.toleranceMs ?? 1500,
        allowExtraTransitions: true,
      });
      expect(failures, formatFailures(failures, recorded)).toHaveLength(0);
    });
  });

  it("dispose-mid-cycle records a final idle/dispose transition", async () => {
    // settleMs:0 keeps state busy at dispose (CompletionTimer's hold is queued
    // but never fires without the settle advance). dispose() then emits the
    // safety idle/dispose so the renderer never stays stuck in "working".
    const { cast } = fixture("claude-normal-turn");
    const recorded = await replayCast(cast, {
      agentId: "claude",
      settleMs: 0,
    });
    expect(recorded.length, formatRecorded(recorded)).toBeGreaterThanOrEqual(2);
    // First recorded must be the boot-busy emit at t=0.
    expect(recorded[0]).toMatchObject({ replayMs: 0, state: "busy" });
    // Last recorded must be the dispose-emitted idle.
    const last = recorded[recorded.length - 1];
    expect(last.state).toBe("idle");
    expect(last.trigger).toBe("dispose");
    // No `completed` should have fired with settleMs=0 — the polling cycles
    // never run long enough to trigger completion detection past the spinner-
    // active window. If this fails, the harness's settle/timer ordering has
    // changed in a way that affects the dispose contract.
    const completedCount = recorded.filter((r) => r.state === "completed").length;
    expect(completedCount, formatRecorded(recorded)).toBe(0);
  });

  it("CPU-high blocks idle until CPU drops past the natural-idle threshold", async () => {
    // The cast's natural idle (prompt fast-path) would fire at ~4850ms when
    // quietForMs >= PROMPT_FAST_PATH_MIN_QUIET_MS=3000 and workingHoldUntil
    // has elapsed. We hold CPU high until 5500ms — past the natural idle —
    // so any idle before 5500ms proves the CPU gate is working. With the
    // gate, idle should fire on the first polling cycle after the drop.
    const cpuSwitchAtMs = 5500;
    const validator: ProcessStateValidator = {
      hasActiveChildren: () => true,
      getDescendantsCpuUsage: () => (Date.now() < cpuSwitchAtMs ? 50 : 0),
    };
    const { cast, expected } = fixture("cpu-high-blocks-idle");
    const expectedFile = loadExpected(expected);
    const recorded = await replayCast(cast, {
      agentId: expectedFile.agentId ?? "claude",
      settleMs: expectedFile.settleMs,
      pollingMaxBootMs: expectedFile.pollingMaxBootMs,
      maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
      idleDebounceMs: expectedFile.idleDebounceMs,
      processStateValidator: validator,
    });
    // No idle event allowed before the CPU drop — proves causation, not coincidence.
    const earlyIdle = recorded.find((r) => r.state === "idle" && r.replayMs < cpuSwitchAtMs);
    expect(earlyIdle, formatRecorded(recorded)).toBeUndefined();
    // After the drop, idle must fire on the next polling cycle.
    const failures = matchTransitions(recorded, expectedFile.transitions, {
      toleranceMs: expectedFile.toleranceMs ?? 250,
    });
    expect(failures, formatFailures(failures, recorded)).toHaveLength(0);
  });

  it("input cast events drive monitor.onInput and trigger busy", async () => {
    // Fixture includes an `i` event that simulates the user pressing Enter
    // after a short shell output — the monitor should transition to busy via
    // the input path (trigger:"input").
    const { cast, expected } = fixture("input-event-triggers-busy");
    const expectedFile = loadExpected(expected);
    const recorded = await replayCast(cast, {
      agentId: expectedFile.agentId,
      settleMs: expectedFile.settleMs,
      pollingMaxBootMs: expectedFile.pollingMaxBootMs,
      maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
    });
    const failures = matchTransitions(recorded, expectedFile.transitions, {
      toleranceMs: expectedFile.toleranceMs ?? 200,
    });
    expect(failures, formatFailures(failures, recorded)).toHaveLength(0);
  });
});

function formatFailures(
  failures: ReturnType<typeof matchTransitions>,
  recorded: RecordedTransition[]
): string {
  if (failures.length === 0) return "";
  const fail = failures
    .map((f) => {
      const expected = formatExpected(f.expected);
      const actual = f.actual ? formatTransition(f.actual) : "";
      return `  - [${f.index}] ${f.kind}${expected ? `: expected ${expected}` : ""}${actual ? ` got ${actual}` : ""}${f.detail ? ` (${f.detail})` : ""}`;
    })
    .join("\n");
  return `Match failures:\n${fail}\n${formatRecorded(recorded)}`;
}

function formatExpected(t?: ExpectedTransition): string {
  if (!t) return "";
  const parts: string[] = [`atMs=${t.atMs}`, `state=${t.state}`];
  if (t.trigger) parts.push(`trigger=${t.trigger}`);
  if (t.waitingReason) parts.push(`waitingReason=${t.waitingReason}`);
  if (t.sessionCost !== undefined) parts.push(`sessionCost=${t.sessionCost}`);
  if (t.sessionTokens !== undefined) parts.push(`sessionTokens=${t.sessionTokens}`);
  return `{ ${parts.join(", ")} }`;
}

function formatTransition(t: RecordedTransition): string {
  const parts: string[] = [`replayMs=${t.replayMs}`, `state=${t.state}`];
  if (t.trigger) parts.push(`trigger=${t.trigger}`);
  if (t.waitingReason) parts.push(`waitingReason=${t.waitingReason}`);
  if (t.sessionCost !== undefined) parts.push(`sessionCost=${t.sessionCost}`);
  if (t.sessionTokens !== undefined) parts.push(`sessionTokens=${t.sessionTokens}`);
  return `{ ${parts.join(", ")} }`;
}

function formatRecorded(recorded: RecordedTransition[]): string {
  const lines = recorded.map((r) => `  ${r.replayMs}ms ${r.state}/${r.trigger ?? "-"}`);
  return `Recorded transitions (${recorded.length}):\n${lines.join("\n")}`;
}
