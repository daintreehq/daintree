import { describe, expect, it } from "vitest";
import {
  DIFF_TEXT_MIN_CONTRAST,
  DISPLAY_SURFACES,
  blendOverBackground,
  contrastRatio,
  getThemeContrastWarnings,
  resolveDiffTextBackdrops,
} from "../contrast.js";
import { hexToOklch, liftToContrast, oklchToHex } from "../oklch.js";
import { BUILT_IN_APP_SCHEMES, deriveDiffTextInks, normalizeAppColorScheme } from "../themes.js";

const INKS = [
  ["diff-text-insert", "status-success"],
  ["diff-text-delete", "status-danger"],
] as const;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("DiffStat churn inks (#15319)", () => {
  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: both inks hold AA on every backdrop churn paints on",
    (_id, scheme) => {
      const backdrops = resolveDiffTextBackdrops(scheme.tokens);
      // Every display surface, the preview frame's tint and four row fills over each.
      expect(backdrops.map((b) => b.label).sort()).toEqual(
        DISPLAY_SURFACES.flatMap((surface) => [
          surface,
          `tint at 4% over ${surface}`,
          `overlay-subtle over ${surface}`,
          `overlay-soft over ${surface}`,
          `overlay-highlight over ${surface}`,
          `overlay-selected over ${surface}`,
        ]).sort()
      );
      for (const [key] of INKS) {
        for (const backdrop of backdrops) {
          const ratio = contrastRatio(scheme.tokens[key], backdrop.hex);
          expect(
            ratio,
            `${key} ${scheme.tokens[key]} on ${backdrop.label} is ${ratio.toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(DIFF_TEXT_MIN_CONTRAST);
        }
      }
    }
  );

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "%s: each ink keeps its status ink's hue and only moves away from the surfaces",
    (_id, scheme) => {
      for (const [key, source] of INKS) {
        const ink = hexToOklch(scheme.tokens[key])!;
        const status = hexToOklch(scheme.tokens[source])!;
        expect(hueDistance(ink.h, status.h), `${key} hue`).toBeLessThan(1.5);
        if (scheme.type === "dark") expect(ink.l).toBeGreaterThanOrEqual(status.l - 1e-6);
        else expect(ink.l).toBeLessThanOrEqual(status.l + 1e-6);
      }
    }
  );

  it("measures the git confirm preview frame, which the status inks fail in the default theme", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const elevated = daintree.tokens["surface-panel-elevated"];
    const frame = blendOverBackground(daintree.tokens.tint, elevated, 0.04);
    const backdrop = resolveDiffTextBackdrops(daintree.tokens).find(
      (b) => b.label === "tint at 4% over surface-panel-elevated"
    );
    expect(backdrop?.hex).toBe(frame);
    for (const [key, source] of INKS) {
      expect(contrastRatio(daintree.tokens[source], frame)).toBeLessThan(DIFF_TEXT_MIN_CONTRAST);
      expect(contrastRatio(daintree.tokens[key], frame)).toBeGreaterThanOrEqual(
        DIFF_TEXT_MIN_CONTRAST
      );
    }
  });

  it("gates a theme whose churn inks are the bare status inks", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const warnings = getThemeContrastWarnings({
      ...daintree,
      tokens: {
        ...daintree.tokens,
        "diff-text-insert": daintree.tokens["status-success"],
        "diff-text-delete": daintree.tokens["status-danger"],
      },
    });
    const messages = warnings.filter((w) => w.kind === "low-contrast").map((w) => w.message);
    expect(messages.some((m) => m.startsWith("diff-text-insert on "))).toBe(true);
    expect(messages.some((m) => m.startsWith("diff-text-delete on "))).toBe(true);
  });

  it("reports an ink it can't measure instead of passing it", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const warnings = getThemeContrastWarnings({
      ...daintree,
      tokens: { ...daintree.tokens, "diff-text-insert": "color-mix(in oklab, red 50%, blue)" },
    });
    expect(
      warnings.some((w) => w.kind === "unevaluable" && w.message.includes("diff-text-insert"))
    ).toBe(true);
  });

  it("re-lifts from an imported theme's own status ink and surfaces", () => {
    // A teal far from the fallback theme's green, so an ink inherited from the
    // fallback can't pass for one lifted from this theme's status ink.
    const scheme = normalizeAppColorScheme({
      id: "dim-teal",
      name: "Dim teal",
      type: "dark",
      tokens: { "status-success": "#1f5560", "surface-panel-elevated": "#3a3a3a" },
    });
    const ink = scheme.tokens["diff-text-insert"];
    expect(ink).not.toBe("#1f5560");
    expect(hueDistance(hexToOklch(ink)!.h, hexToOklch("#1f5560")!.h)).toBeLessThan(1.5);
    for (const backdrop of resolveDiffTextBackdrops(scheme.tokens)) {
      expect(contrastRatio(ink, backdrop.hex)).toBeGreaterThanOrEqual(DIFF_TEXT_MIN_CONTRAST);
    }
    expect(getThemeContrastWarnings(scheme).filter((w) => w.message.includes("diff-text"))).toEqual(
      []
    );
  });

  it("names a row fill or tint it can't composite instead of skipping it silently", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const warnings = getThemeContrastWarnings({
      ...daintree,
      tokens: {
        ...daintree.tokens,
        "overlay-selected": "color-mix(in srgb, #ffffff 40%, #000000)",
        tint: "color-mix(in srgb, #ffffff 90%, #000000)",
      },
    });
    const unevaluable = warnings.filter((w) => w.kind === "unevaluable").map((w) => w.message);
    expect(
      unevaluable.some((m) => m.includes("diff churn") && m.includes("overlay-selected"))
    ).toBe(true);
    expect(unevaluable.some((m) => m.includes("diff churn") && m.includes("tint="))).toBe(true);
  });

  it("composites the preview frame with the alpha the tint already carries", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const elevated = daintree.tokens["surface-panel-elevated"];
    const frameFor = (tint: string) =>
      resolveDiffTextBackdrops({ ...daintree.tokens, tint }).find(
        (b) => b.label === "tint at 4% over surface-panel-elevated"
      )?.hex;
    expect(frameFor("rgba(255, 255, 255, 1)")).toBe(blendOverBackground("#ffffff", elevated, 0.04));
    expect(frameFor("#ffffff80")).toBe(
      blendOverBackground("#ffffff", elevated, 0.04 * (0x80 / 255))
    );
  });

  it("keeps a churn ink the theme names, even one the gate rejects", () => {
    const scheme = normalizeAppColorScheme({
      id: "named-ink",
      name: "Named ink",
      type: "dark",
      tokens: { "diff-text-insert": "#406040" },
    });
    expect(scheme.tokens["diff-text-insert"]).toBe("#406040");
    expect(
      getThemeContrastWarnings(scheme).some((w) => w.message.startsWith("diff-text-insert on "))
    ).toBe(true);
  });

  it("derives both inks from a token set, as colour-vision mode does with its overrides", () => {
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    const inks = deriveDiffTextInks(
      { ...daintree.tokens, "status-success": "#009e73", "status-danger": "#fe6100" },
      "dark"
    );
    const backdrops = resolveDiffTextBackdrops(daintree.tokens);
    for (const ink of [inks["diff-text-insert"]!, inks["diff-text-delete"]!]) {
      for (const backdrop of backdrops) {
        expect(contrastRatio(ink, backdrop.hex)).toBeGreaterThanOrEqual(DIFF_TEXT_MIN_CONTRAST);
      }
    }
  });
});

describe("liftToContrast", () => {
  it("returns an ink that already reads untouched", () => {
    expect(liftToContrast("#eeeeee", ["#111111"], 4.5, "dark")).toBe("#eeeeee");
  });

  it("lightens on dark and darkens on light, holding the hue", () => {
    const dark = liftToContrast("#3a6b45", ["#2a2a2a"], 4.5, "dark");
    expect(contrastRatio(dark, "#2a2a2a")).toBeGreaterThanOrEqual(4.5);
    expect(hexToOklch(dark)!.l).toBeGreaterThan(hexToOklch("#3a6b45")!.l);
    expect(hueDistance(hexToOklch(dark)!.h, hexToOklch("#3a6b45")!.h)).toBeLessThan(1.5);
    // The nearest lightness that reads, not merely one that does.
    const back = oklchToHex({ ...hexToOklch(dark)!, l: hexToOklch(dark)!.l - 0.01 });
    expect(contrastRatio(back, "#2a2a2a")).toBeLessThan(4.5);

    const light = liftToContrast("#5fae6f", ["#f2efe8"], 4.5, "light");
    expect(contrastRatio(light, "#f2efe8")).toBeGreaterThanOrEqual(4.5);
    expect(hexToOklch(light)!.l).toBeLessThan(hexToOklch("#5fae6f")!.l);
  });

  it("finds a lightness between a dark and a light backdrop when the far end fails", () => {
    // White fails against the white backdrop, but a mid grey clears 3:1 on both.
    const ink = liftToContrast("#222222", ["#000000", "#ffffff"], 3, "dark");
    expect(contrastRatio(ink, "#000000")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ink, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("lifts a hex whose alpha byte says fully opaque", () => {
    const ink = liftToContrast("#3a6b45ff", ["#2a2a2a"], 4.5, "dark");
    expect(ink).toBe(liftToContrast("#3a6b45", ["#2a2a2a"], 4.5, "dark"));
  });

  it("leaves values it can't lift for the gate to report", () => {
    expect(liftToContrast("oklch(0.5 0.1 140)", ["#2a2a2a"], 4.5, "dark")).toBe(
      "oklch(0.5 0.1 140)"
    );
    expect(liftToContrast("#3a6b4580", ["#2a2a2a"], 4.5, "dark")).toBe("#3a6b4580");
    // No lightness of anything reads 4.5:1 on mid grey from both sides at once.
    expect(liftToContrast("#3a6b45", ["#777777", "#ffffff"], 4.5, "dark")).toBe("#3a6b45");
  });

  it("lands where measuring every candidate as a formatted hex lands", () => {
    // Inks and backdrops in every form the parsers accept or reject, plus a
    // seeded spread, so the reuse of luminances can't drift from the search
    // the built-in themes were tuned against (#15673).
    let seed = 15673;
    const randomHex = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return `#${seed.toString(16).padStart(6, "0").slice(-6)}`;
    };
    const inks = [
      "#3a6b45",
      "#5fae6f",
      "#222222",
      "#eeeeee",
      "#3A6B45",
      "  #3a6b45 ",
      "#abc",
      "#abcf",
      "#3a6b45ff",
      "#3a6b4580",
      "oklch(0.5 0.1 140)",
      ...Array.from({ length: 24 }, randomHex),
    ];
    const backdropSets = [
      [],
      ["#2a2a2a"],
      ["#f2efe8"],
      ["#000000", "#ffffff"],
      ["#777777", "#ffffff"],
      ["#1d2125", "#fff", "#2a2a2aff", " #333333"],
      ["#2a2a2a", "rgba(0, 0, 0, 0.5)"],
      ["#777f", "#3338", "#2a2a2a80"],
      Array.from({ length: 12 }, randomHex),
    ];
    let compared = 0;
    for (const ink of inks) {
      for (const backdrops of backdropSets) {
        for (const minimum of [3, 4.55, 7]) {
          for (const type of ["dark", "light"] as const) {
            expect(liftToContrast(ink, backdrops, minimum, type)).toBe(
              referenceLift(ink, backdrops, minimum, type)
            );
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(inks.length * backdropSets.length * 3 * 2);
  });
});

// `liftToContrast` before #15673: each candidate formatted to hex, and both
// strings of every pair re-read for every ratio. The parser and the formatter
// are frozen copies too, so a change to the shared helpers can't move both sides.
function referenceLuminance(hex: string): number {
  const linear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const clean = hex.trim().replace("#", "");
  const rgb =
    clean.length === 3 || clean.length === 4
      ? clean
          .slice(0, 3)
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean.slice(0, 6);
  const red = linear(parseInt(rgb.slice(0, 2), 16));
  const green = linear(parseInt(rgb.slice(2, 4), 16));
  const blue = linear(parseInt(rgb.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function referenceOklchToHex({ l, c, h }: { l: number; c: number; h: number }): string {
  const toLinear = (L: number, a: number, b: number) => {
    const lc = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mc = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const sc = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
      -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
      -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
    ];
  };
  const inGamut = (channels: number[]) => channels.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  const toHexByte = (value: number) => {
    const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  let keep = 1;
  if (!inGamut(toLinear(l, a, b))) {
    let lo = 0;
    let hi = 1;
    for (let step = 0; step < 16; step++) {
      const mid = (lo + hi) / 2;
      if (inGamut(toLinear(l, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
    keep = lo;
  }
  return `#${toLinear(l, a * keep, b * keep)
    .map(toHexByte)
    .join("")}`;
}

function referenceLift(
  ink: string,
  backdrops: readonly string[],
  minimum: number,
  type: "dark" | "light"
): string {
  const opaque = /^#(?:[0-9a-f]{3}f?|[0-9a-f]{6}(?:ff)?)$/i;
  const start = opaque.test(ink.trim()) ? hexToOklch(ink.trim()) : null;
  if (!start) return ink;
  const ratio = (a: string, b: string) => {
    const la = referenceLuminance(a);
    const lb = referenceLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const reads = (hex: string) => backdrops.every((backdrop) => ratio(hex, backdrop) >= minimum);
  if (reads(ink.trim())) return ink;
  const at = (l: number) => referenceOklchToHex({ ...start, l });
  const end = type === "dark" ? 1 : 0;
  let near = start.l;
  let far: number | null = null;
  for (let step = 1; step <= 32; step++) {
    const l = start.l + ((end - start.l) * step) / 32;
    if (reads(at(l))) {
      far = l;
      break;
    }
    near = l;
  }
  if (far === null) return ink;
  let pass = far;
  for (let step = 0; step < 24; step++) {
    const mid = (near + pass) / 2;
    if (reads(at(mid))) pass = mid;
    else near = mid;
  }
  return at(pass);
}

describe("oklchToHex", () => {
  it("inverts hexToOklch", () => {
    for (const hex of ["#6b8d72", "#c8746c", "#017249", "#e89478", "#808080"]) {
      expect(oklchToHex(hexToOklch(hex)!)).toBe(hex);
    }
  });

  it("gives up chroma, not hue, when the colour is outside sRGB", () => {
    const hex = oklchToHex({ l: 0.95, c: 0.3, h: 145 });
    const back = hexToOklch(hex)!;
    expect(back.c).toBeLessThan(0.3);
    expect(hueDistance(back.h, 145)).toBeLessThan(2);
  });
});
