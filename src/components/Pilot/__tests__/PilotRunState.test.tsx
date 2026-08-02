// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BAND_GLYPH, PilotRunState } from "../PilotRunState";
import { FLEET_BANDS, isDemandBand, type FleetBand } from "@/lib/fleetAttention";
import type { AgentState } from "@shared/types/agent";

/**
 * The colour utilities on a band's rendered glyph.
 *
 * Deliberately extracted rather than compared to a literal: the invariants
 * below are about which bands share a tone and which shapes stay distinct, so
 * changing a token should not have to be typed out twice.
 */
function toneOf(band: FleetBand, agentState?: AgentState): string {
  const { container, unmount } = render(<PilotRunState band={band} agentState={agentState} />);
  const svg = container.querySelector("svg");
  const tones = (svg?.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((cls) => cls.startsWith("text-"))
    .sort()
    .join(" ");
  unmount();
  return tones;
}

/**
 * The glyph's own geometry, which is what makes a state readable without hue.
 *
 * The whole child markup, not a chosen attribute or two: the spinner and the
 * hollow circle are the same `<circle r="6">` and separate only on
 * `strokeDasharray` — a 270° arc against a closed ring. Sampling attributes by
 * hand reported them identical, which would have let a genuinely
 * indistinguishable pair through unnoticed. Tone stays out of this by
 * construction, since the class rides the `<svg>` root rather than its children.
 */
function shapeOf(band: FleetBand, agentState?: AgentState): string {
  const { container, unmount } = render(<PilotRunState band={band} agentState={agentState} />);
  const shape = container.querySelector("svg")?.innerHTML ?? "";
  unmount();
  return shape;
}

const DEMAND_BANDS = FLEET_BANDS.filter(isDemandBand);
const NEUTRAL_BANDS = FLEET_BANDS.filter((band) => !isDemandBand(band));

describe("PilotRunState", () => {
  it("gives every band a glyph", () => {
    // A band with no entry would render nothing at all, leaving the row's left
    // scan column empty for exactly the state nobody thought about.
    for (const band of FLEET_BANDS) {
      expect(BAND_GLYPH[band]).toBeTruthy();
    }
  });

  it("paints one shared neutral tone across every state without a demand", () => {
    // Running, done and idle gave up their hue: colour is the signal that
    // something needs the user, and three more hues competing with it is what
    // made two waiting agents invisible among five working ones.
    const tones = new Set(NEUTRAL_BANDS.map((band) => toneOf(band)));
    expect(tones.size).toBe(1);
  });

  it("keeps the directing and exited refinements inside that neutral tone", () => {
    // Both used to carry a colour of their own — `directing` a category blue,
    // `exited` a dimmer grey. Neither is a demand.
    const neutral = toneOf("done");
    expect(toneOf("running", "directing")).toBe(neutral);
    expect(toneOf("idle", "exited")).toBe(neutral);
  });

  it("hues every band that is a demand, and none that isn't", () => {
    const neutral = toneOf("done");
    for (const band of DEMAND_BANDS) {
      expect(toneOf(band)).not.toBe(neutral);
    }
    expect(new Set(DEMAND_BANDS.map((band) => toneOf(band))).size).toBe(DEMAND_BANDS.length);
  });

  it("keeps shape as a second channel, so the neutral states stay tellable apart", () => {
    // Working, finished and exited are all neutral now, so geometry is the only
    // thing left separating them — never colour alone, and never its absence.
    const shapes = [
      shapeOf("running"),
      shapeOf("running", "directing"),
      shapeOf("done"),
      shapeOf("idle"),
      shapeOf("idle", "exited"),
    ];

    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("spins only the run that is actually working", () => {
    const spinning = (band: FleetBand, agentState?: AgentState) => {
      const { container, unmount } = render(<PilotRunState band={band} agentState={agentState} />);
      const cls = container.querySelector("svg")?.getAttribute("class") ?? "";
      unmount();
      return cls.includes("animate-spin");
    };

    expect(spinning("running")).toBe(true);
    // Directing is a person typing, not a process grinding.
    expect(spinning("running", "directing")).toBe(false);
    expect(spinning("idle")).toBe(false);
  });
});
