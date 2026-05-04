import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadExpectedFsm,
  matchFsmTransitions,
  replayCastFsm,
  type ExpectedFsmTransition,
  type RecordedFsmTransition,
  type ReplayCastFsmOpts,
} from "./replay/castReplayHarness.js";
import type { ProcessStateValidator } from "../ActivityMonitor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "agent-state-machine");

function fixture(name: string) {
  return {
    cast: path.join(FIXTURE_DIR, `${name}.cast`),
    expected: path.join(FIXTURE_DIR, `${name}.expected.json`),
  };
}

interface ReplayCase {
  name: string;
  agentId: string;
}

const REPLAY_CASES: ReplayCase[] = [
  { name: "claude-watchdog-timeout", agentId: "claude" },
  { name: "claude-respawn", agentId: "claude" },
];

describe("AgentStateMachine replay harness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor to a positive epoch so AgentStateChangedSchema's
    // `timestamp: z.number().int().positive()` accepts the very first
    // emitted event. Starting at 0 silently drops the first transition.
    vi.setSystemTime(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  describe.each(REPLAY_CASES)("$name (no fragmentation)", ({ name, agentId }) => {
    it("produces the expected FSM transition sequence", async () => {
      const { cast, expected } = fixture(name);
      const expectedFile = loadExpectedFsm(expected);
      const opts: ReplayCastFsmOpts = {
        agentId: expectedFile.agentId ?? agentId,
        settleMs: expectedFile.settleMs,
        pollingMaxBootMs: expectedFile.pollingMaxBootMs,
        maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
        maxWaitingSilenceMs: expectedFile.maxWaitingSilenceMs,
        idleDebounceMs: expectedFile.idleDebounceMs,
        promptFastPathMinQuietMs: expectedFile.promptFastPathMinQuietMs,
      };
      const recorded = await replayCastFsm(cast, opts);
      const failures = matchFsmTransitions(recorded, expectedFile.transitions, {
        allowExtraTransitions: expectedFile.allowExtraTransitions ?? false,
      });
      expect(failures, formatFailures(failures, recorded)).toHaveLength(0);
    });
  });

  it("does not fire watchdog when processStateValidator reports active children", async () => {
    // Inverse of the watchdog-timeout fixture: with hasActiveChildren()===true
    // the watchdog must NOT fire, and the FSM must stay in `waiting`. Guards
    // against regressions in the `hasChildren !== false` gate that prevents
    // the watchdog from forcing idle on agents that are actually still alive.
    const aliveValidator: ProcessStateValidator = { hasActiveChildren: () => true };
    const { cast, expected } = fixture("claude-watchdog-timeout");
    const expectedFile = loadExpectedFsm(expected);
    const recorded = await replayCastFsm(cast, {
      agentId: expectedFile.agentId ?? "claude",
      settleMs: expectedFile.settleMs,
      maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
      maxWaitingSilenceMs: expectedFile.maxWaitingSilenceMs,
      processStateValidator: aliveValidator,
    });
    const states = recorded.map((r) => r.state);
    expect(states, formatRecorded(recorded)).not.toContain("idle");
    expect(states[states.length - 1], formatRecorded(recorded)).toBe("waiting");
  });

  describe.each([
    { name: "claude-watchdog-timeout", agentId: "claude", seed: 1 },
    { name: "claude-watchdog-timeout", agentId: "claude", seed: 2 },
    { name: "claude-watchdog-timeout", agentId: "claude", seed: 3 },
    { name: "claude-respawn", agentId: "claude", seed: 1 },
    { name: "claude-respawn", agentId: "claude", seed: 2 },
    { name: "claude-respawn", agentId: "claude", seed: 3 },
  ])("$name fragmented (seed=$seed)", ({ name, agentId, seed }) => {
    it("preserves the expected FSM state sequence under chunk-boundary fragmentation", async () => {
      const { cast, expected } = fixture(name);
      const expectedFile = loadExpectedFsm(expected);
      const recorded = await replayCastFsm(cast, {
        agentId: expectedFile.agentId ?? agentId,
        settleMs: expectedFile.settleMs,
        pollingMaxBootMs: expectedFile.pollingMaxBootMs,
        maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
        maxWaitingSilenceMs: expectedFile.maxWaitingSilenceMs,
        idleDebounceMs: expectedFile.idleDebounceMs,
        promptFastPathMinQuietMs: expectedFile.promptFastPathMinQuietMs,
        fragmentation: { seed, maxSplits: 4 },
      });
      // Fragmented playback exercises chunk-boundary parsing in xterm. The
      // load-bearing invariant is the FSM state sequence — chunk boundaries
      // can introduce extra activity-driven pulses (e.g. a brief
      // working→completed→waiting trio) that don't change the load-bearing
      // exit/respawn/watchdog transitions, so allowExtraTransitions is on.
      const failures = matchFsmTransitions(recorded, expectedFile.transitions, {
        allowExtraTransitions: true,
      });
      expect(failures, formatFailures(failures, recorded)).toHaveLength(0);
    });
  });
});

function formatFailures(
  failures: ReturnType<typeof matchFsmTransitions>,
  recorded: RecordedFsmTransition[]
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

function formatExpected(t?: ExpectedFsmTransition): string {
  if (!t) return "";
  const parts: string[] = [`state=${t.state}`];
  if (t.previousState) parts.push(`previousState=${t.previousState}`);
  if (t.trigger) parts.push(`trigger=${t.trigger}`);
  if (t.confidence !== undefined) parts.push(`confidence=${t.confidence}`);
  return `{ ${parts.join(", ")} }`;
}

function formatTransition(t: RecordedFsmTransition): string {
  return `{ replayMs=${t.replayMs}, ${t.previousState}→${t.state}, trigger=${t.trigger}, confidence=${t.confidence} }`;
}

function formatRecorded(recorded: RecordedFsmTransition[]): string {
  const lines = recorded.map(
    (r) => `  ${r.replayMs}ms ${r.previousState}→${r.state}/${r.trigger} (conf=${r.confidence})`
  );
  return `Recorded transitions (${recorded.length}):\n${lines.join("\n")}`;
}
