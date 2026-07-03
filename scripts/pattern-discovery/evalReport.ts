/**
 * Re-export of the agent-state replay eval report types/renderer. The
 * implementation lives beside the cast replay harness
 * (`electron/services/__tests__/replay/evalReport.ts`) so the electron TS
 * project stays self-contained; this module keeps the pattern-discovery
 * toolkit surface complete (record → analyze → update → replay → eval).
 *
 * Run the eval with `npm run pattern-discovery:eval`; the report lands in
 * `.tmp/agent-state-eval/report.md`.
 */
export {
  renderEvalReport,
  summarizeFailureKinds,
  type FixtureEvalResult,
  type FixtureFailure,
} from "../../electron/services/__tests__/replay/evalReport.js";
