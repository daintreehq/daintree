import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkForbidden,
  loadExpected,
  matchCheckResult,
  matchFsmTransitions,
  matchTransitions,
  replayCastThroughFsm,
  type MatchFailure,
  type RecordedFsmTransition,
  type RecordedTransition,
} from "./replay/castReplayHarness.js";
import { renderEvalReport, type FixtureEvalResult } from "./replay/evalReport.js";

/**
 * Corpus eval: replays EVERY fixture in fixtures/activity-monitor/ through the
 * full production pipeline (headless xterm → ActivityMonitor → AgentStateService
 * → agent:state-changed) and scores the recording against the fixture's
 * .expected.json. Fixtures self-register — drop a cast + expected pair in the
 * directory and it runs here, no test edit needed.
 *
 * A score report (per-agent pass rates, failure classes) is written to
 * .tmp/agent-state-eval/report.md after the run. `npm run pattern-discovery:eval`
 * runs just this spec plus the activity-tier replay spec.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "activity-monitor");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const REPORT_DIR = path.join(REPO_ROOT, ".tmp", "agent-state-eval");

// AgentStateChangedSchema requires positive timestamps, so the virtual clock
// anchors at a real epoch instead of 0. `performance` is faked alongside the
// timer APIs so AgentStateService's hysteresis window runs on replay time.
const REPLAY_EPOCH_MS = 1_700_000_000_000;
const FAKED_APIS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "Date",
  "performance",
] as const;

const FIXTURES = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".expected.json"))
  .map((f) => f.replace(/\.expected\.json$/, ""))
  .sort();

const results: FixtureEvalResult[] = [];

describe("agent-state corpus eval (activity + FSM tiers)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED_APIS] });
    vi.setSystemTime(REPLAY_EPOCH_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterAll(() => {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, "report.md"), renderEvalReport(results));
    fs.writeFileSync(path.join(REPORT_DIR, "report.json"), JSON.stringify(results, null, 2));
    const failed = results.filter((r) => r.failures.length > 0).length;
    console.log(
      `[agent-state-eval] ${results.length - failed}/${results.length} fixtures passed — report: .tmp/agent-state-eval/report.md`
    );
  });

  it.each(FIXTURES)("%s", async (name) => {
    let expectedFile;
    let result;
    try {
      expectedFile = loadExpected(path.join(FIXTURE_DIR, `${name}.expected.json`));
      result = await replayCastThroughFsm(path.join(FIXTURE_DIR, `${name}.cast`), {
        agentId: expectedFile.agentId,
        settleMs: expectedFile.settleMs,
        pollingMaxBootMs: expectedFile.pollingMaxBootMs,
        maxWorkingSilenceMs: expectedFile.maxWorkingSilenceMs,
        idleDebounceMs: expectedFile.idleDebounceMs,
        promptFastPathMinQuietMs: expectedFile.promptFastPathMinQuietMs,
      });
    } catch (error) {
      // A fixture that fails to parse or replay must still appear in the
      // score report as a failure, not silently vanish from it.
      results.push({
        fixture: name,
        agentId: expectedFile?.agentId ?? "unknown",
        fsmTier: expectedFile?.fsm !== undefined,
        activityTransitions: 0,
        fsmTransitions: 0,
        failures: [{ kind: "crash", detail: String(error) }],
      });
      throw error;
    }

    const failures: MatchFailure[] = [];
    failures.push(
      ...matchTransitions(result.activity, expectedFile.transitions, {
        toleranceMs: expectedFile.toleranceMs ?? 200,
        allowExtraTransitions: expectedFile.allowExtraTransitions ?? false,
      })
    );
    if (expectedFile.fsm) {
      failures.push(
        ...matchFsmTransitions(result.fsm, expectedFile.fsm.transitions, {
          toleranceMs: expectedFile.fsm.toleranceMs ?? expectedFile.toleranceMs ?? 200,
          allowExtraTransitions: expectedFile.fsm.allowExtraTransitions ?? false,
        })
      );
      failures.push(...matchCheckResult(expectedFile.fsm.checkResult, result.finalCheckResult));
      if (
        expectedFile.fsm.finalWaitingReason !== undefined &&
        result.finalWaitingReason !== expectedFile.fsm.finalWaitingReason
      ) {
        failures.push({
          kind: "final-waiting-reason",
          index: 0,
          detail: `settled waitingReason=${result.finalWaitingReason ?? "-"}, expected ${expectedFile.fsm.finalWaitingReason}`,
        });
      }
    }
    failures.push(...checkForbidden(expectedFile.forbidden, result.activity, result.fsm));

    results.push({
      fixture: name,
      agentId: expectedFile.agentId ?? "universal",
      fsmTier: expectedFile.fsm !== undefined,
      activityTransitions: result.activity.length,
      fsmTransitions: result.fsm.length,
      failures: failures.map((f) => ({ kind: f.kind, detail: describeFailure(f) })),
    });

    expect(failures, formatFailures(failures, result.activity, result.fsm)).toHaveLength(0);
  });
});

function describeFailure(f: MatchFailure): string {
  if (f.detail) return f.detail;
  const expected = f.expected
    ? `expected ${f.expected.state}${f.expected.trigger ? `/${f.expected.trigger}` : ""} near ${f.expected.atMs}ms`
    : "";
  const actual = f.actual ? `got ${f.actual.state} at ${f.actual.replayMs}ms` : "";
  return [expected, actual].filter(Boolean).join(", ") || f.kind;
}

function formatFailures(
  failures: MatchFailure[],
  activity: RecordedTransition[],
  fsm: RecordedFsmTransition[]
): string {
  if (failures.length === 0) return "";
  const failureLines = failures.map((f) => `  - ${f.kind}: ${describeFailure(f)}`).join("\n");
  const activityLines = activity
    .map((r) => `  ${r.replayMs}ms ${r.state}/${r.trigger ?? "-"}`)
    .join("\n");
  const fsmLines = fsm
    .map(
      (r) =>
        `  ${r.replayMs}ms ${r.previousState} → ${r.state}/${r.trigger}` +
        `${r.waitingReason ? ` reason=${r.waitingReason}` : ""}` +
        `${r.sessionCost !== undefined ? ` cost=${r.sessionCost}` : ""}` +
        `${r.sessionTokens !== undefined ? ` tokens=${r.sessionTokens}` : ""}` +
        `${r.exitCode !== undefined ? ` exit=${r.exitCode}` : ""}` +
        `${r.checkResult ? ` check=${r.checkResult.passed ? "pass" : "fail"}` : ""}`
    )
    .join("\n");
  return `Failures:\n${failureLines}\nRecorded activity (${activity.length}):\n${activityLines}\nRecorded FSM (${fsm.length}):\n${fsmLines}`;
}
