import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const COMPONENT_PATH = resolve(__dirname, "../StreakFlame.tsx");

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

  it("returns accent CSS var for days 240+", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(240)).toBe("var(--color-accent-primary)");
    expect(mod.getStreakColor(10000)).toBe("var(--color-accent-primary)");
  });

  it("returns amber for 0 days (fallback)", async () => {
    const mod = await import("../StreakFlame");
    expect(mod.getStreakColor(0)).toBe("#F59E0B");
  });
});

describe("StreakFlame component structure", () => {
  let content: string;

  it("loads the component file", async () => {
    content = await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toBeTruthy();
  });

  it("uses useId() for gradient ID uniqueness", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("useId()");
  });

  it("uses overflow: visible on SVG", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain('overflow: "visible"');
  });

  it("uses willChange: transform on <g>", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain('willChange: "transform"');
  });

  it("uses transformBox: fill-box on <g>", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain('transformBox: "fill-box"');
  });

  it("checks localStorage for daily animation gating", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("streak-flame-last-played");
    expect(content).toContain("localStorage.getItem");
    expect(content).toContain("localStorage.setItem");
  });

  it("cancels rAF on cleanup", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("cancelAnimationFrame");
  });

  it("disconnects IntersectionObserver on cleanup", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("observer?.disconnect()");
  });

  it("respects prefers-reduced-motion", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("prefers-reduced-motion: reduce");
  });

  it("uses streak-flame-glow class for reduced motion", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("streak-flame-glow");
  });

  it("throttles rAF to ~14fps", async () => {
    content ??= await readFile(COMPONENT_PATH, "utf-8");
    expect(content).toContain("1000 / 14");
  });
});
