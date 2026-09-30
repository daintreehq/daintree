import { describe, expect, it } from "vitest";
import { labelColors, labelTextContrast, parseLabelHex } from "../kitLabelColor";

// A spread of real label colours: GitHub's defaults, near-white, near-black and
// fully saturated primaries, the cases a fixed tint gets wrong.
const COLOURS = [
  "#d73a4a",
  "#0075ca",
  "#cfd3d7",
  "#a2eeef",
  "#7057ff",
  "#008672",
  "#e4e669",
  "#fef2c0",
  "#ffffff",
  "#000000",
  "#0e0e52",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  "#f0f",
];

const SURFACES = {
  light: ["#ffffff", "#f6f7f9", "rgba(250, 250, 250, 1)"],
  dark: ["#18181b", "#1e1f22", "#2b2d31"],
} as const;

describe("parseLabelHex", () => {
  it("reads 3- and 6-digit hex with or without #", () => {
    expect(parseLabelHex("#fff")).toEqual([255, 255, 255]);
    expect(parseLabelHex("d73a4a")).toEqual([215, 58, 74]);
  });

  it("refuses anything else", () => {
    for (const bad of ["red", "#ggg", "#12345", "", 42, null, "rgb(0,0,0)"]) {
      expect(parseLabelHex(bad)).toBeNull();
    }
  });
});

describe("labelColors", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const surface of SURFACES[mode]) {
      it(`reads at 4.5:1 for every colour on ${mode} ${surface}`, () => {
        for (const colour of COLOURS) {
          expect(labelTextContrast(colour, surface, mode), colour).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it("composites a translucent surface token before measuring", () => {
    // A light theme whose panel is a 10% black wash over white: white text must
    // not survive on the near-white result.
    const colours = labelColors("#ffffff", "rgba(0, 0, 0, 0.1)", "light");
    expect(colours?.color).not.toBe("#ffffff");
    expect(labelTextContrast("#ffffff", "rgba(0, 0, 0, 0.1)", "light")).toBeGreaterThanOrEqual(4.5);
  });

  it("reads on every surface it is given, not just the pane", () => {
    // One text colour, measured over the pane and its neighbours at once.
    const light = ["#ffffff", "#f4f4f5", "rgba(0, 0, 0, 0.06)"];
    const dark = ["#18181b", "#232326", "rgba(255, 255, 255, 0.08)"];
    for (const colour of COLOURS) {
      expect(labelTextContrast(colour, light, "light"), colour).toBeGreaterThanOrEqual(4.5);
      expect(labelTextContrast(colour, dark, "dark"), colour).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps a colour that already reads", () => {
    expect(labelColors("#0e0e52", "#ffffff", "light")?.color).toBe("#0e0e52");
  });

  it("darkens on light and lightens on dark", () => {
    const light = labelColors("#e4e669", "#ffffff", "light");
    const dark = labelColors("#0e0e52", "#18181b", "dark");
    expect(light?.color).not.toBe("#e4e669");
    expect(dark?.color).not.toBe("#0e0e52");
    const lum = (hex: string) => parseLabelHex(hex)!.reduce((sum, c) => sum + c, 0);
    expect(lum(light!.color)).toBeLessThan(lum("#e4e669"));
    expect(lum(dark!.color)).toBeGreaterThan(lum("#0e0e52"));
  });

  it("falls back to a default surface when the token is unreadable", () => {
    expect(labelColors("#d73a4a", undefined, "dark")).not.toBeNull();
    expect(labelColors("#d73a4a", "not-a-colour", "light")).not.toBeNull();
  });

  it("is null for a non-hex colour", () => {
    expect(labelColors("blue", "#ffffff", "light")).toBeNull();
  });
});
