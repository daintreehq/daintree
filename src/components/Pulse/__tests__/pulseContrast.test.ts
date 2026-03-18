import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CARD_PATH = resolve(__dirname, "../ProjectPulseCard.tsx");
const SUMMARY_PATH = resolve(__dirname, "../PulseSummary.tsx");

describe("ProjectPulseCard — visual contrast (issue #2645)", () => {
  it("card shell uses bg-canopy-sidebar for consistent card styling", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("bg-canopy-sidebar");
    expect(content).not.toContain("p-4 bg-surface ");
    expect(content).not.toContain('"w-fit bg-surface ');
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

  it("button hover uses tint overlay pattern, not surface token", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("hover:bg-tint/5");
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
