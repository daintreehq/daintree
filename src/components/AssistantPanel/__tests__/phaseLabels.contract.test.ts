import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LIVE_STATUS_LABEL, STAGE_LABEL } from "../AssistantPanelView";

/**
 * The phase labels, against the engine's own list of phase names.
 *
 * These two sources drift silently. The engine's canonical wire names are snake_case
 * (`tool_running`, `awaiting_approval`); the panel once keyed its labels on hyphenated
 * spellings, so four phases quietly missed every lookup — the composer showed the
 * generic "Processing…" while a turn sat waiting on an approval, and the inline status
 * line showed nothing at all. Nothing failed; the label was just wrong, which is the
 * kind of bug a type cannot catch because the phase crosses the wire as a free string.
 *
 * Read from the Go source rather than restated here, so adding a phase to the engine
 * fails this test instead of silently landing without a label.
 */

const RUNPHASE = path.resolve(
  __dirname,
  "../../../../vendor/daintree-assistant/internal/domain/runphase.go"
);

/** The `phaseNames` map's values — the exact strings the engine puts on the wire. */
function enginePhaseNames(): string[] {
  const source = readFileSync(RUNPHASE, "utf8");
  const block = /var phaseNames = map\[RunPhase\]string\{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error("phaseNames map not found in runphase.go");
  return [...block[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/**
 * Phases that carry no label by design.
 *
 * The terminal three end the turn, so the live line is gone before they could show.
 * `received` is stamped on the turn marker, and `tool_queued` is covered by the
 * activity rows the batch announcement draws.
 */
const NO_LIVE_LABEL = new Set([
  "received",
  "tool_queued",
  "tool_running",
  "complete",
  "failed",
  "cancelled",
]);
const NO_STAGE_LABEL = new Set(["tool_queued", "complete", "failed", "cancelled"]);

describe("phase label contract", () => {
  const phases = enginePhaseNames();

  it("reads a plausible phase list out of the engine", () => {
    // Guards the regex itself: a silently-empty list would make every case below vacuous.
    expect(phases.length).toBeGreaterThanOrEqual(10);
    expect(phases).toContain("tool_running");
    expect(phases).toContain("awaiting_approval");
  });

  it("gives every non-terminal phase a composer stage label", () => {
    const missing = phases.filter((p) => !NO_STAGE_LABEL.has(p) && !STAGE_LABEL[p]);
    expect(missing, `phases with no stage label: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every silent-work phase an inline live label", () => {
    const missing = phases.filter((p) => !NO_LIVE_LABEL.has(p) && !LIVE_STATUS_LABEL[p]);
    expect(missing, `phases with no live label: ${missing.join(", ")}`).toEqual([]);
  });

  it("labels nothing the engine cannot emit", () => {
    const known = new Set(phases);
    const strays = [...Object.keys(STAGE_LABEL), ...Object.keys(LIVE_STATUS_LABEL)].filter(
      (k) => !known.has(k)
    );
    expect(strays, `labels for phases the engine never sends: ${strays.join(", ")}`).toEqual([]);
  });

  it("agrees with itself on the verb wherever both maps name a phase", () => {
    // The cockpit deliberately paired them ("Writing" / "Writing…") so the inline line
    // and the composer cue could never describe the same turn differently.
    for (const [phase, live] of Object.entries(LIVE_STATUS_LABEL)) {
      const stage = STAGE_LABEL[phase];
      if (!stage) continue;
      expect(stage, `"${phase}" disagrees between the two rows`).toBe(`${live}…`);
    }
  });
});
