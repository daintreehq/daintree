/**
 * Score-report rendering for the agent-state replay eval
 * (`electron/services/__tests__/AgentStateFsm.replay.test.ts`).
 *
 * The eval walks every fixture in
 * `electron/services/__tests__/fixtures/activity-monitor/`, replays it through
 * the production detection pipeline, and collects match failures. This module
 * turns those results into a per-agent score table so a detector change shows
 * its blast radius at a glance: false positives, false negatives, wrong
 * waiting reasons, wrong completion/check extraction, forbidden-transition
 * violations.
 */

export interface FixtureFailure {
  kind: string;
  detail: string;
}

export interface FixtureEvalResult {
  fixture: string;
  agentId: string;
  /** Whether the fixture exercised the canonical-FSM tier (fsm block present). */
  fsmTier: boolean;
  activityTransitions: number;
  fsmTransitions: number;
  failures: FixtureFailure[];
}

/**
 * Human meaning of each failure kind, in report order. "missing" is a false
 * negative (the pipeline never produced the expected transition inside its
 * time window — late transitions land here too); "extra" is a false positive.
 */
const KIND_LABELS: Array<[string, string]> = [
  ["missing", "false negatives (missed/late transitions)"],
  ["extra", "false positives (spurious transitions)"],
  ["forbidden", "forbidden transitions (pinned false positives)"],
  ["waiting-reason-mismatch", "wrong waiting reason"],
  ["final-waiting-reason", "wrong settled waiting reason"],
  ["check-result", "wrong check-result extraction"],
];

export function summarizeFailureKinds(results: FixtureEvalResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    for (const failure of result.failures) {
      counts[failure.kind] = (counts[failure.kind] ?? 0) + 1;
    }
  }
  return counts;
}

export function renderEvalReport(results: FixtureEvalResult[]): string {
  const sorted = [...results].sort((a, b) => a.fixture.localeCompare(b.fixture));
  const passed = sorted.filter((r) => r.failures.length === 0);
  const failed = sorted.filter((r) => r.failures.length > 0);
  const kindCounts = summarizeFailureKinds(sorted);

  const byAgent = new Map<string, { total: number; passed: number }>();
  for (const result of sorted) {
    const entry = byAgent.get(result.agentId) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (result.failures.length === 0) entry.passed += 1;
    byAgent.set(result.agentId, entry);
  }

  const lines: string[] = [];
  lines.push("# Agent-state replay eval");
  lines.push("");
  lines.push(`Fixtures: ${sorted.length} · passed: ${passed.length} · failed: ${failed.length}`);
  lines.push("");

  lines.push("## Failure classes");
  lines.push("");
  const knownKinds = new Set(KIND_LABELS.map(([kind]) => kind));
  const kindLines: string[] = [];
  for (const [kind, label] of KIND_LABELS) {
    const count = kindCounts[kind] ?? 0;
    if (count > 0) kindLines.push(`- ${label}: ${count}`);
  }
  for (const [kind, count] of Object.entries(kindCounts)) {
    if (!knownKinds.has(kind)) kindLines.push(`- ${kind}: ${count}`);
  }
  if (kindLines.length === 0) {
    lines.push("- none — all fixtures matched their expectations");
  } else {
    lines.push(...kindLines);
  }
  lines.push("");

  lines.push("## Per-agent");
  lines.push("");
  lines.push("| Agent | Fixtures | Passed |");
  lines.push("| --- | --- | --- |");
  for (const [agentId, entry] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${agentId} | ${entry.total} | ${entry.passed} |`);
  }
  lines.push("");

  lines.push("## Fixtures");
  lines.push("");
  for (const result of sorted) {
    const status = result.failures.length === 0 ? "PASS" : "FAIL";
    const tier = result.fsmTier ? "activity+fsm" : "activity";
    lines.push(
      `- ${status} \`${result.fixture}\` (${result.agentId}, ${tier}, ` +
        `${result.activityTransitions} activity / ${result.fsmTransitions} fsm transitions)`
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure.kind}: ${failure.detail}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
