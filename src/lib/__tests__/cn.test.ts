import { describe, expect, it } from "vitest";
import { cn } from "../utils";

describe("cn", () => {
  it("keeps bg-noise beside a background colour", () => {
    // `bg-noise` is the grid's grain layer and its positioning context, not a
    // fill; merging it away beside the drop-target frame's fill unpositioned
    // the grid.
    const tokens = cn("h-full bg-noise p-1", "bg-overlay-subtle").split(" ");
    expect(tokens).toContain("bg-noise");
    expect(tokens).toContain("bg-overlay-subtle");
  });

  it("still resolves conflicting background colours to the last", () => {
    expect(cn("bg-surface-panel", "bg-overlay-subtle")).toBe("bg-overlay-subtle");
  });
});
