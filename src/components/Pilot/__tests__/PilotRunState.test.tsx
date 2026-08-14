// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PilotRunState } from "../PilotRunState";
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
/** Nothing in flight and nothing being asked — the states that stay grey. */
const QUIET_BANDS: FleetBand[] = ["done", "parked", "idle"];

describe("PilotRunState", () => {
  it("paints one shared neutral tone across the states that are not news", () => {
    // An acknowledged completion and an exited shell are finished business.
    // Hueing them would put back the competing signals that made two waiting
    // agents invisible among five working ones.
    const tones = new Set(QUIET_BANDS.map((band) => toneOf(band)));

    expect(tones.size).toBe(1);
    // A set of one is also what "no tone at all" produces, and an uncoloured
    // glyph would fall through to whatever the row happens to be painted.
    expect([...tones][0]).not.toBe("");
  });

  it("hues a working run, because working is a live fact and not a quiet one", () => {
    // The rest of the app — the sidebar's quick filters, the assistant header,
    // the dock — has always said working in colour. The overview reading it as
    // ordinary text was the one surface speaking a second language.
    expect(toneOf("running")).not.toBe(toneOf("done"));
  });

  it("keeps the directing refinement inside the working tone", () => {
    // Directing is a person typing at a working agent, not a different state.
    expect(toneOf("running", "directing")).toBe(toneOf("running"));
  });

  it("keeps the exited refinement inside the quiet tone", () => {
    expect(toneOf("idle", "exited")).toBe(toneOf("idle"));
  });

  it("separates work in flight from work handed back", () => {
    // The collision this exists to prevent: `activity-completed` is unset in
    // every built-in theme and falls back to `status-success`, which is the
    // same hex as `activity-working` in five of them. Hueing `running` without
    // moving `review` off that fallback would leave spinner-versus-check as the
    // only difference between two states an operator has to tell apart.
    expect(toneOf("review")).not.toBe(toneOf("running"));
  });

  it("hues every band that is a demand, in a colour of its own", () => {
    const quiet = toneOf("done");
    for (const band of DEMAND_BANDS) {
      expect(toneOf(band)).not.toBe(quiet);
    }
    expect(new Set(DEMAND_BANDS.map((band) => toneOf(band))).size).toBe(DEMAND_BANDS.length);
  });

  it("keeps shape as a second channel, so the quiet states stay tellable apart", () => {
    // Working, finished and exited carry no demand between them, so geometry is
    // what separates them — never colour alone, and never its absence.
    const shapes = [
      shapeOf("running"),
      shapeOf("running", "directing"),
      shapeOf("done"),
      shapeOf("parked"),
      shapeOf("idle"),
      shapeOf("idle", "exited"),
    ];

    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("separates an errored agent from one asking a question by shape, not just hue", () => {
    // These two shared the hollow circle and differed only in colour, with the
    // row's visible status word carrying the real distinction. That word is
    // gone, and "the agent stopped" versus "the agent asked you something" is
    // too far apart to leave resting on a hue a colour-vision remap can move.
    expect(shapeOf("blocked")).not.toBe(shapeOf("needs-you"));
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
