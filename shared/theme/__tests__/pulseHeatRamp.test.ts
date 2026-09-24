import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { deltaEOK } from "../contrast.js";

// Clearly above the ~0.02 JND: a level-1 day that only just clears JND still
// reads as a quiet day at 10px, which is the defect this guards against.
const MIN_STEP_DELTA_E = 0.05;

const HEX = /^#[0-9A-Fa-f]{6}$/;

describe("pulse heat ramp — every authored step is visibly distinct", () => {
  const STOPS = ["pulse-heat-1", "pulse-heat-2", "pulse-heat-3", "pulse-heat-4"] as const;
  const authored = BUILT_IN_THEME_SOURCES.filter((theme) =>
    STOPS.every((key) => HEX.test(theme.extensions?.[key] ?? ""))
  );

  it("covers the themes that author opaque heat stops", () => {
    expect(authored.length).toBeGreaterThan(0);
  });

  it.each(authored.map((theme) => [theme.id, theme] as const))(
    "%s: empty → heat-1 → … → heat-4 each step clears the floor",
    (_id, theme) => {
      const ext = theme.extensions!;
      const empty = ext["pulse-empty-bg"];
      if (!empty || !HEX.test(empty)) return;
      const ramp = [
        empty,
        ext["pulse-heat-1"]!,
        ext["pulse-heat-2"]!,
        ext["pulse-heat-3"]!,
        ext["pulse-heat-4"]!,
      ];
      for (let i = 1; i < ramp.length; i += 1) {
        expect(
          deltaEOK(ramp[i - 1]!, ramp[i]!),
          `${theme.id}: step ${i - 1}→${i} (${ramp[i - 1]} → ${ramp[i]})`
        ).toBeGreaterThanOrEqual(MIN_STEP_DELTA_E);
      }
    }
  );
});
