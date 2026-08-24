import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LIVE_STATUS_LABEL } from "../AssistantPanelView";

/**
 * The phase labels, against the engine's own list of phase names.
 *
 * These two sources drift silently. The engine's canonical wire names are snake_case
 * (`tool_running`, `awaiting_approval`); the panel once keyed its labels on hyphenated
 * spellings, so four phases quietly missed every lookup — the status line showed
 * nothing at all while a turn sat waiting on an approval. Nothing failed; the label was
 * just wrong, which is the kind of bug a type cannot catch because the phase crosses
 * the wire as a free string.
 *
 * Read from the Go source rather than restated here, so adding a phase to the engine
 * fails this test instead of silently landing without a label.
 */

const RUNPHASE = path.resolve(
  __dirname,
  "../../../../vendor/daintree-assistant/internal/domain/runphase.go"
);

/**
 * The `phaseNames` map's values — the exact strings the engine puts on the wire.
 *
 * Tolerant about the DECLARATION (Go permits `var (` grouping, and gofmt is free to
 * space a map literal differently) and strict about the VALUES, because a value this
 * misses is a phase the panel silently has no label for. `[a-z0-9_]` rather than
 * `[a-z_]`: a phase named `retry_v2` is a perfectly ordinary thing to add, and the
 * narrower class would skip it while every check below still passed.
 */
function enginePhaseNames(): string[] {
  const source = readFileSync(RUNPHASE, "utf8");
  const block = /phaseNames\s*=\s*map\[RunPhase\]string\{([\s\S]*?)\n\s*\}/.exec(source);
  if (!block) throw new Error("phaseNames map not found in runphase.go");
  return [...block[1]!.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
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

describe("phase label contract", () => {
  const phases = enginePhaseNames();

  it("reads a plausible phase list out of the engine", () => {
    // Guards the regex itself: a silently-empty list would make every case below vacuous.
    expect(phases.length).toBeGreaterThanOrEqual(10);
    expect(phases).toContain("tool_running");
    expect(phases).toContain("awaiting_approval");
    // Every name is unique and non-empty — a regex that started matching comment text
    // or struct tags would show up here rather than as a passing suite with junk in it.
    expect(new Set(phases).size).toBe(phases.length);
  });

  it("exempts only phases the engine actually has", () => {
    // The half Codex found missing. Both exemption sets are hand-written, so a phase
    // RENAMED or REMOVED in the engine leaves its old name sitting in them — and a
    // stale exemption is invisible: it excuses a phase that no longer exists while the
    // real one goes unlabelled through the very check the exemption was meant to skip.
    const known = new Set(phases);
    const stale = [...NO_LIVE_LABEL].filter((p) => !known.has(p));
    expect(
      [...new Set(stale)],
      `exemptions for phases the engine no longer has: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("gives every silent-work phase an inline live label", () => {
    const missing = phases.filter((p) => !NO_LIVE_LABEL.has(p) && !LIVE_STATUS_LABEL[p]);
    expect(missing, `phases with no live label: ${missing.join(", ")}`).toEqual([]);
  });

  it("labels nothing the engine cannot emit", () => {
    const known = new Set(phases);
    const strays = Object.keys(LIVE_STATUS_LABEL).filter((k) => !known.has(k));
    expect(strays, `labels for phases the engine never sends: ${strays.join(", ")}`).toEqual([]);
  });
});
