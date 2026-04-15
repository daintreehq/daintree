import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CARD_PATH = resolve(__dirname, "../ProjectPulseCard.tsx");
const SUMMARY_PATH = resolve(__dirname, "../PulseSummary.tsx");
const HEATMAP_PATH = resolve(__dirname, "../PulseHeatmap.tsx");

describe("ProjectPulseCard — visual contrast (issue #2645)", () => {
  it("card shell uses pulse component vars for per-theme shell styling", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('"pulse-card');
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
    expect(content).toContain("text-daintree-text/90");
  });

  it("no card text uses /50 or /60 opacity (below secondary floor)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-daintree-text/50");
    expect(content).not.toContain("text-daintree-text/60");
  });

  it("coaching line uses at least /80 opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/80");
  });

  it("coaching line does not use italic styling", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    const coachLineMatch = content.match(/getCoachLine\(pulse\).*<\/p>/s);
    expect(coachLineMatch).toBeTruthy();
    const coachLineBlock = coachLineMatch![0];
    expect(coachLineBlock).not.toContain("italic");
  });

  it("button hover uses the pulse control hover component var", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('"pulse-control');
  });

  it("card header uses pulse-card-header class for per-theme header tinting", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('"pulse-card-header');
  });

  it("inline selector active item uses accent tint fill, not a surface token", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("color-mix(in oklab, var(--color-accent-primary) 12%, transparent)");
    expect(content).not.toMatch(/rangeDays.*bg-surface-highlight/);
  });
});

describe("PulseSummary — visual contrast (issue #2645)", () => {
  it("Stat non-highlight text uses /75 opacity (not /60)", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/75");
    expect(content).not.toContain("text-daintree-text/60");
  });

  it("Stat label uses /55 opacity floor (not /40)", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/55");
    expect(content).not.toContain("text-daintree-text/40");
  });

  it("delta row does not use opacity below the /55 tertiary floor", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).not.toContain("text-daintree-text/30");
    expect(content).not.toContain("text-daintree-text/40");
    expect(content).not.toContain("text-daintree-text/50");
  });

  it("delta insertions/deletions use at least /80 semantic colour", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-status-success/80");
    expect(content).toContain("text-status-error/80");
  });
});

describe("PulseHeatmap — contrast on elevated card (issue #2645)", () => {
  it("heatmap uses square indicators and pulse component vars", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("rounded-[2px]");
    expect(content).toContain("var(--pulse-empty-bg");
    expect(content).toContain("var(--pulse-missed-bg)");
  });

  it("most-recent-active ring uses the pulse ring offset token", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("var(--pulse-ring-offset");
    expect(content).not.toContain('cell.isToday && "ring-2');
  });
});
