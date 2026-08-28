import { describe, expect, it } from "vitest";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import type { CIStatus } from "@shared/types/forge";

const status = (state: CIStatus["state"]): CIStatus => ({ state }) as CIStatus;
const REPORTABLE = ["success", "failure", "pending", "neutral"] as const;

describe("getCIStatusVisual", () => {
  it("marks a run still in flight with a dot and a settled one with a glyph", () => {
    // GitHub's own vocabulary, and the one the forge dropdown rows speak. A
    // change here silently puts two views of the same PR out of step.
    expect(getCIStatusVisual(status("pending"))?.kind).toBe("dot");
    expect(getCIStatusVisual(status("success"))?.kind).toBe("icon");
    expect(getCIStatusVisual(status("failure"))?.kind).toBe("icon");
  });

  it("keeps only one state on the dot, so shape survives forced colors", () => {
    // Every dot collapses to the same system-coloured disc under
    // `forced-colors: active` — a second one would be indistinguishable from
    // pending for the users that override the strongest.
    const dots = REPORTABLE.filter((state) => getCIStatusVisual(status(state))?.kind === "dot");
    expect(dots).toEqual(["pending"]);
  });

  it("keeps the glyph states distinguishable by shape alone", () => {
    const icons = REPORTABLE.map((state) => getCIStatusVisual(status(state))!)
      .filter((visual) => visual.kind === "icon")
      .map((visual) => visual.Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("paints the dot as a background and its label as text", () => {
    // The two halves diverge on purpose: a background is what the shared
    // `.status-mark` hook rescues under forced colors, and text alongside it
    // needs a colour the same override leaves alone.
    for (const state of REPORTABLE) {
      const visual = getCIStatusVisual(status(state))!;
      if (visual.kind === "dot") {
        expect(visual.colorClass.startsWith("bg-")).toBe(true);
        expect(visual.labelClass.startsWith("text-")).toBe(true);
      } else {
        expect(visual.colorClass.startsWith("text-")).toBe(true);
      }
    }
  });

  it("gives every state it renders its own wording", () => {
    const labels = REPORTABLE.map((state) => getCIStatusVisual(status(state))!);
    expect(new Set(labels.map((visual) => visual.shortLabel)).size).toBe(labels.length);
    expect(new Set(labels.map((visual) => visual.ariaLabel)).size).toBe(labels.length);
  });

  it("renders nothing for an absent or unknown status", () => {
    expect(getCIStatusVisual(null)).toBeNull();
    expect(getCIStatusVisual(undefined)).toBeNull();
    expect(getCIStatusVisual(status("unknown"))).toBeNull();
  });
});
