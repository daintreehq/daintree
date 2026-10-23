import { describe, expect, it } from "vitest";
import { agentLaunchLimit } from "../agentLaunchCapacity.js";

const GIB = 1024 ** 3;

describe("agentLaunchLimit (#14221)", () => {
  it("gives the 36 GB host from the incident fewer agents than the 13 that took it down", () => {
    const limit = agentLaunchLimit(36 * GIB);
    expect(limit).not.toBeNull();
    expect(limit!).toBeLessThan(13);
    expect(limit!).toBeGreaterThan(1);
  });

  it("always lets a small machine run one", () => {
    expect(agentLaunchLimit(2 * GIB)).toBe(1);
    expect(agentLaunchLimit(1)).toBe(1);
  });

  it("grows with memory and never shrinks", () => {
    let previous = 0;
    for (let gb = 1; gb <= 512; gb += 1) {
      const limit = agentLaunchLimit(gb * GIB)!;
      expect(limit).toBeGreaterThanOrEqual(previous);
      previous = limit;
    }
  });

  it("keeps back a bounded reserve, so a large machine isn't left a fraction-sized hole", () => {
    // Past the reserve cap, every further budget's worth of memory is one more agent.
    for (const gb of [64, 128, 256, 1024]) {
      expect(agentLaunchLimit((gb + 4) * GIB)).toBe(agentLaunchLimit(gb * GIB)! + 1);
    }
  });

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "gives no limit when memory is unknown (%s)",
    (total) => {
      expect(agentLaunchLimit(total)).toBeNull();
    }
  );
});
