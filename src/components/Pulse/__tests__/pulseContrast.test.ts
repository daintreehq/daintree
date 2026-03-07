import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CARD_PATH = resolve(__dirname, "../ProjectPulseCard.tsx");
const SUMMARY_PATH = resolve(__dirname, "../PulseSummary.tsx");
const HEATMAP_PATH = resolve(__dirname, "../PulseHeatmap.tsx");

describe("ProjectPulseCard — visual contrast (issue #2645)", () => {
  it("card shell does not use low-contrast bg-surface", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("bg-surface-highlight");
    expect(content).not.toContain("p-4 bg-surface ");
    expect(content).not.toContain('"w-fit bg-surface ');
  });

  it("all four card state variants include the specular top-edge shadow", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    const specularCount = (
      content.match(/shadow-\[inset_0_1px_0_0_rgba\(255,255,255,0\.07\)\]/g) ?? []
    ).length;
    // loading, empty-repo, error, populated = 4 occurrences
    expect(specularCount).toBeGreaterThanOrEqual(4);
  });

  it("Activity icon does not use reduced-opacity status-success", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-status-success/70");
  });

  it("error and info state icons do not use reduced opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-status-error/70");
    expect(content).not.toContain("text-status-info/70");
  });

  it("primary title text uses at least /90 opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/90");
  });

  it("no card text uses /50 or /60 opacity (below secondary floor)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-canopy-text/50");
    expect(content).not.toContain("text-canopy-text/60");
  });

  it("coaching line uses at least /80 opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/80");
  });

  it("button hover uses white overlay pattern, not surface token", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("hover:bg-white/5");
    expect(content).not.toContain("hover:bg-surface-highlight");
  });

  it("dropdown selected item uses accent tint, not surface token", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("bg-canopy-accent/15");
    // bg-surface-highlight for active item would be invisible on elevated card
    expect(content).not.toMatch(/rangeDays.*bg-surface-highlight/);
  });
});

describe("PulseSummary — visual contrast (issue #2645)", () => {
  it("Stat non-highlight text uses /75 opacity (not /60)", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/75");
    expect(content).not.toContain("text-canopy-text/60");
  });

  it("Stat label uses /55 opacity floor (not /40)", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/55");
    expect(content).not.toContain("text-canopy-text/40");
  });

  it("delta row does not use opacity below the /55 tertiary floor", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).not.toContain("text-canopy-text/30");
    expect(content).not.toContain("text-canopy-text/40");
    expect(content).not.toContain("text-canopy-text/50");
  });

  it("delta insertions/deletions use at least /80 semantic colour", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-status-success/80");
    expect(content).toContain("text-status-error/80");
  });
});

describe("PulseHeatmap — contrast on elevated card (issue #2645)", () => {
  it("BEFORE_PROJECT_COLOR uses text-tone neutral mix (not raw canvas bg)", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    // bg-canopy-bg (#19191a) has only 1.24:1 against elevated card #2b2b2c
    expect(content).not.toContain('"bg-canopy-bg"');
  });

  it("MISSED_DAY_COLOR uses at least 30% error mix for visibility on elevated card", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    // 20% was too close to card bg; 32% provides better separation
    expect(content).toContain("status-error)_32%");
  });
});
