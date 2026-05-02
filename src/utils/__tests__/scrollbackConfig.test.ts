import { describe, it, expect } from "vitest";
import { estimateMemoryUsage } from "../scrollbackConfig";

describe("estimateMemoryUsage", () => {
  it("computes per-type and total bytes for a typical 8-agent + 8-shell session", () => {
    const result = estimateMemoryUsage({ agent: 8, plain: 8 }, 1000);
    // agent: 1000 * 1.5 = 1500 lines/term, 1500 * 1200 * 8 = 14,400,000
    // plain: 1000 * 0.3 =  300 lines/term,  300 * 1200 * 8 =  2,880,000
    // total = 17,280,000
    expect(result.agent).toBe(14_400_000);
    expect(result.plain).toBe(2_880_000);
    expect(result.total).toBe(17_280_000);
  });

  it("computes a single agent terminal at default scrollback", () => {
    const result = estimateMemoryUsage({ agent: 1, plain: 0 }, 1000);
    expect(result.agent).toBe(1_800_000);
    expect(result.plain).toBe(0);
    expect(result.total).toBe(1_800_000);
  });

  it("computes a single plain terminal at default scrollback", () => {
    const result = estimateMemoryUsage({ agent: 0, plain: 1 }, 1000);
    expect(result.agent).toBe(0);
    expect(result.plain).toBe(360_000);
    expect(result.total).toBe(360_000);
  });

  it("uses maxLines for unlimited scrollback (base=0)", () => {
    const result = estimateMemoryUsage({ agent: 8, plain: 8 }, 0);
    // agent: 5000 lines/term, plain: 2000 lines/term
    expect(result.agent).toBe(5000 * 1200 * 8); // 48,000,000
    expect(result.plain).toBe(2000 * 1200 * 8); // 19,200,000
    expect(result.total).toBe(67_200_000);
  });

  it("returns zeros when there are no terminals", () => {
    const result = estimateMemoryUsage({ agent: 0, plain: 0 }, 1000);
    expect(result.agent).toBe(0);
    expect(result.plain).toBe(0);
    expect(result.total).toBe(0);
  });
});
