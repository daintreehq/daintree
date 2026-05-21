import { describe, expect, it } from "vitest";

import type { ViewportPresetId } from "@shared/types/panel";

import {
  VIEWPORT_PRESET_LIST,
  VIEWPORT_PRESETS,
  getViewportPreset,
  getEffectiveViewportSize,
  computeFitScale,
} from "../viewportPresets";

describe("VIEWPORT_PRESETS", () => {
  it("renders smallest-to-largest in the chip row order", () => {
    expect(VIEWPORT_PRESET_LIST.map((p) => p.id)).toEqual(["galaxy", "iphone", "pixel", "ipad"]);
  });

  it("Galaxy S25 covers the sub-393 px breakpoint", () => {
    expect(VIEWPORT_PRESETS.galaxy).toMatchObject({
      id: "galaxy",
      label: "Galaxy S25",
      width: 360,
      height: 780,
    });
    expect(VIEWPORT_PRESETS.galaxy.userAgent).toContain("Android 15");
    expect(VIEWPORT_PRESETS.galaxy.userAgent).toContain("SM-S931U");
  });

  it("iPhone 16 keeps the iPhone 15 dimensions", () => {
    expect(VIEWPORT_PRESETS.iphone).toMatchObject({
      id: "iphone",
      label: "iPhone 16",
      width: 393,
      height: 852,
    });
    expect(VIEWPORT_PRESETS.iphone.userAgent).toContain("iPhone OS 18_0");
  });

  it("Pixel 9 ticks height up to 923", () => {
    expect(VIEWPORT_PRESETS.pixel).toMatchObject({
      id: "pixel",
      label: "Pixel 9",
      width: 412,
      height: 923,
    });
    expect(VIEWPORT_PRESETS.pixel.userAgent).toContain("Android 15");
    expect(VIEWPORT_PRESETS.pixel.userAgent).toContain("Pixel 9");
  });

  it("iPad Air M3 keeps the iPad Air dimensions", () => {
    expect(VIEWPORT_PRESETS.ipad).toMatchObject({
      id: "ipad",
      label: "iPad Air M3",
      width: 820,
      height: 1180,
    });
    expect(VIEWPORT_PRESETS.ipad.userAgent).toContain("CPU OS 18_0");
  });
});

describe("getViewportPreset", () => {
  it("returns the matching preset for a known id", () => {
    expect(getViewportPreset("galaxy")).toBe(VIEWPORT_PRESETS.galaxy);
    expect(getViewportPreset("iphone")).toBe(VIEWPORT_PRESETS.iphone);
    expect(getViewportPreset("pixel")).toBe(VIEWPORT_PRESETS.pixel);
    expect(getViewportPreset("ipad")).toBe(VIEWPORT_PRESETS.ipad);
  });

  it("falls back to iphone when given a stale persisted id", () => {
    const stale = "nokia" as unknown as ViewportPresetId;
    expect(getViewportPreset(stale)).toBe(VIEWPORT_PRESETS.iphone);
  });
});

describe("getEffectiveViewportSize", () => {
  it("returns preset dimensions when not rotated", () => {
    expect(getEffectiveViewportSize("ipad", false)).toEqual({ width: 820, height: 1180 });
  });

  it("swaps width and height when rotated to landscape", () => {
    expect(getEffectiveViewportSize("ipad", true)).toEqual({ width: 1180, height: 820 });
    expect(getEffectiveViewportSize("galaxy", true)).toEqual({ width: 780, height: 360 });
  });
});

describe("computeFitScale", () => {
  it("scales a tall viewport down to fit the limiting dimension", () => {
    // iPad portrait 820×1180 in a 900×800 pane — height is the constraint
    expect(computeFitScale(900, 800, 820, 1180)).toBeCloseTo(800 / 1180, 5);
  });

  it("scales a wide viewport down when width is the constraint", () => {
    // iPad landscape 1180×820 in a narrow 300×1200 pane — width is the constraint
    expect(computeFitScale(300, 1200, 1180, 820)).toBeCloseTo(300 / 1180, 5);
  });

  it("never upscales a small viewport (caps at 1)", () => {
    // Galaxy 360×780 in a huge 1920×1200 pane stays device-accurate
    expect(computeFitScale(1920, 1200, 360, 780)).toBe(1);
  });

  it("returns 1 when the container has not been measured yet", () => {
    expect(computeFitScale(0, 0, 820, 1180)).toBe(1);
  });
});
