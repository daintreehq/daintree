import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CARD_PATH = resolve(__dirname, "../ProjectPulseCard.tsx");
const SUMMARY_PATH = resolve(__dirname, "../PulseSummary.tsx");

describe("ProjectPulseCard — visual contrast (issue #2645)", () => {
  it("uses bg-surface-highlight for all state variant card shells", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("bg-surface-highlight");
    expect(content).not.toContain("p-4 bg-surface ");
    expect(content).not.toContain('"w-fit bg-surface ');
  });

  it("adds specular top-edge shadow to all card shells", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    const specularCount = (
      content.match(/shadow-\[inset_0_1px_0_0_rgba\(255,255,255,0\.07\)\]/g) ?? []
    ).length;
    expect(specularCount).toBeGreaterThanOrEqual(4);
  });

  it("uses full-opacity status-success icon (no /70 suffix)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('text-status-success"');
    expect(content).not.toContain("text-status-success/70");
  });

  it("uses full-opacity status-error and status-info icons", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('text-status-error"');
    expect(content).toContain('text-status-info"');
    expect(content).not.toContain("text-status-error/70");
    expect(content).not.toContain("text-status-info/70");
  });

  it("primary text uses /90 or higher opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/90");
  });

  it("secondary text uses /75 floor (no /50 text outside disabled context)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-canopy-text/50");
    expect(content).not.toContain("text-canopy-text/60");
  });

  it("coaching line uses /80 opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/80 italic");
  });

  it("button hover uses overlay pattern (hover:bg-white/5) not surface token", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("hover:bg-white/5");
    expect(content).not.toContain("hover:bg-surface-highlight");
  });
});

describe("PulseSummary — visual contrast (issue #2645)", () => {
  it("Stat default text uses /75 opacity floor", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/75");
  });

  it("Stat label uses /55 opacity floor", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-canopy-text/55");
  });

  it("delta row does not use /30 or /40 opacity text", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).not.toContain("text-canopy-text/30");
    expect(content).not.toContain("text-canopy-text/40");
  });

  it("delta insertions/deletions use /80 semantic colour", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-status-success/80");
    expect(content).toContain("text-status-error/80");
  });
});
