import { describe, it, expect } from "vitest";

describe("getStreakColor — tier boundaries", () => {
  // Import the pure function directly
  let getStreakColor: (days: number) => string;

  it("can be imported", async () => {
    const mod = await import("../StreakFlame");
    getStreakColor = mod.getStreakColor;
    expect(typeof getStreakColor).toBe("function");
  });

  it("returns amber (#F59E0B) for days 1-7", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(1)).toBe("#F59E0B");
    expect(mod.getStreakColor(7)).toBe("#F59E0B");
  });

  it("returns orange (#FB923C) for days 8-14", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(8)).toBe("#FB923C");
    expect(mod.getStreakColor(14)).toBe("#FB923C");
  });

  it("returns orange-red (#F97316) for days 15-29", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(15)).toBe("#F97316");
    expect(mod.getStreakColor(29)).toBe("#F97316");
  });

  it("returns red (#EF4444) for days 30-59", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(30)).toBe("#EF4444");
    expect(mod.getStreakColor(59)).toBe("#EF4444");
  });

  it("returns deep red (#DC2626) for days 60-119", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(60)).toBe("#DC2626");
    expect(mod.getStreakColor(119)).toBe("#DC2626");
  });

  it("returns fuchsia (#C026D3) for days 120-239", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(120)).toBe("#C026D3");
    expect(mod.getStreakColor(239)).toBe("#C026D3");
  });

  it("returns a distinct celebratory hex for days 240+ (issue #9820)", async () => {
    const mod = await import("../StreakFlame");
    // The 240+ tier must read at full color fidelity in PulseSummary.Stat —
    // not borrow --color-accent-primary, which the release chip in the same
    // region already spends. A plain hex keeps it consistent with the other
    // six tiers and avoids a second accent in one focus region.
    const top240 = mod.getStreakColor(240);
    const top10k = mod.getStreakColor(10000);
    expect(top240).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(top10k).toBe(top240);
    expect(top240).not.toContain("var(");
    expect(top240).not.toBe("var(--color-accent-primary)");
    expect(top240).not.toBe(mod.getStreakColor(120));
    expect(top240).not.toBe(mod.getStreakColor(239));
  });

  it("returns amber for 0 days (fallback)", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(0)).toBe("#F59E0B");
  });
});
