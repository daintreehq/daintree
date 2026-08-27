import { describe, expect, it } from "vitest";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import type { CIStatus } from "@shared/types/forge";

const status = (state: CIStatus["state"]): CIStatus => ({ state }) as CIStatus;

describe("getCIStatusVisual", () => {
  it("gives every reportable state a glyph, not a background-painted dot", () => {
    // The point of #12000: a `bg-*` disc is erased by forced-colors, so a state
    // that only had one communicated nothing. Every state that reports at all
    // has to hand back something that strokes.
    for (const state of ["success", "failure", "pending", "neutral"] as const) {
      const visual = getCIStatusVisual(status(state));
      expect(visual).not.toBeNull();
      expect(visual!.Icon).toBeTruthy();
      expect(visual!.colorClass.startsWith("text-")).toBe(true);
    }
  });

  it("keeps the four states visually distinct by shape", () => {
    const icons = (["success", "failure", "pending", "neutral"] as const).map(
      (state) => getCIStatusVisual(status(state))!.Icon
    );
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("labels every state it renders", () => {
    for (const state of ["success", "failure", "pending", "neutral"] as const) {
      const visual = getCIStatusVisual(status(state))!;
      expect(visual.shortLabel).toBeTruthy();
      expect(visual.ariaLabel).toBeTruthy();
    }
  });

  it("renders nothing for an absent or unknown status", () => {
    expect(getCIStatusVisual(null)).toBeNull();
    expect(getCIStatusVisual(undefined)).toBeNull();
    expect(getCIStatusVisual(status("unknown"))).toBeNull();
  });
});
