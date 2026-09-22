import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The sidebar's quick state filter and Pilot's filter bar are one control
// drawn twice: same glyphs, same active underline, and the same dimmed glyph
// for an empty bucket. That dimming step drifted once already — one bar was
// retuned and the other kept the old alpha, so the same empty Finished bucket
// read at two different strengths depending on which surface you looked at.
//
// Read from source rather than rendered because the step only exists as a
// Tailwind class literal (the scanner can't see an assembled `${hue}/N`), and
// the rule is about the literals agreeing, whatever value they settle on.

const here = path.dirname(fileURLToPath(import.meta.url));
const BARS = [
  path.resolve(here, "../QuickStateFilterBar.tsx"),
  path.resolve(here, "../../Pilot/PilotFilterBar.tsx"),
];

/** Every `text-<token>/<step>` class literal a bar assigns to a faded tone. */
function fadeSteps(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const steps: string[] = [];
  for (const match of source.matchAll(
    /(?:colorFaded|toneFaded|_FADED)\s*[:=]\s*"text-[a-z-]+\/(\d+)"/g
  )) {
    steps.push(match[1]!);
  }
  return steps;
}

describe("quick state filter fade parity", () => {
  it("finds the faded tones in both bars", () => {
    // Guards the scan itself: a rename that stopped it matching would
    // otherwise pass the parity check below with nothing to compare.
    for (const bar of BARS) expect(fadeSteps(bar).length).toBeGreaterThanOrEqual(3);
  });

  it("dims every empty-bucket glyph in both bars by the same step", () => {
    const steps = new Set(BARS.flatMap(fadeSteps));
    expect([...steps]).toHaveLength(1);
  });
});
