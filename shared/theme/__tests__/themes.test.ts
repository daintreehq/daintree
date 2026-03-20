import { describe, it, expect } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  DEFAULT_APP_SCHEME_ID,
  createCanopyTokens,
  getAppThemeById,
  getBuiltInAppSchemeForType,
  getAppThemeWarnings,
  normalizeAppColorScheme,
  resolveAppTheme,
} from "../themes.js";
import { APP_THEME_TOKEN_KEYS, type AppColorSchemeTokens } from "../types.js";

function wcagContrastRatio(hex1: string, hex2: string): number {
  function luminance(hex: string): number {
    const c = hex.replace("#", "");
    const e =
      c.length === 3
        ? c
            .split("")
            .map((ch) => `${ch}${ch}`)
            .join("")
        : c;
    const toLinear = (v: number) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * toLinear(parseInt(e.slice(0, 2), 16)) +
      0.7152 * toLinear(parseInt(e.slice(2, 4), 16)) +
      0.0722 * toLinear(parseInt(e.slice(4, 6), 16))
    );
  }
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const REQUIRED_TOKENS = {
  "surface-canvas": "#ffffff",
  "surface-sidebar": "#f8f8f8",
  "surface-panel": "#f0f0f0",
  "surface-panel-elevated": "#e8e8e8",
  "surface-grid": "#fafafa",
  "text-primary": "#1a1a1a",
  "text-secondary": "#555555",
  "text-muted": "#888888",
  "text-inverse": "#ffffff",
  "border-default": "#d0d0d0",
  "accent-primary": "#3F9366",
  "status-success": "#5F8B6D",
  "status-warning": "#C59A4E",
  "status-danger": "#C8746C",
  "status-info": "#7B8C96",
  "activity-active": "#22c55e",
  "activity-idle": "#a0a0a0",
  "activity-working": "#22c55e",
  "activity-waiting": "#fbbf24",
  "terminal-selection": "#d0e8d8",
  "terminal-red": "#dc2626",
  "terminal-green": "#16a34a",
  "terminal-yellow": "#ca8a04",
  "terminal-blue": "#2563eb",
  "terminal-magenta": "#9333ea",
  "terminal-cyan": "#0891b2",
  "terminal-bright-red": "#ef4444",
  "terminal-bright-green": "#22c55e",
  "terminal-bright-yellow": "#eab308",
  "terminal-bright-blue": "#3b82f6",
  "terminal-bright-magenta": "#a855f7",
  "terminal-bright-cyan": "#06b6d4",
  "terminal-bright-white": "#1a1a1a",
  "syntax-comment": "#6b7280",
  "syntax-punctuation": "#374151",
  "syntax-number": "#b45309",
  "syntax-string": "#15803d",
  "syntax-operator": "#0e7490",
  "syntax-keyword": "#7c3aed",
  "syntax-function": "#2563eb",
  "syntax-link": "#0284c7",
  "syntax-quote": "#6b7280",
  "syntax-chip": "#0d9488",
} as const;

describe("createCanopyTokens — light mode derived defaults", () => {
  const lightTokens = createCanopyTokens("light", REQUIRED_TOKENS);

  it("derives border defaults from the theme's foreground ink for light mode", () => {
    expect(lightTokens["border-subtle"]).toBe("rgba(26, 26, 26, 0.06)");
    expect(lightTokens["border-strong"]).toBe("rgba(26, 26, 26, 0.12)");
    expect(lightTokens["border-divider"]).toBe("rgba(26, 26, 26, 0.04)");
  });

  it("derives overlay defaults from the theme's foreground ink for light mode", () => {
    expect(lightTokens["overlay-subtle"]).toBe("rgba(26, 26, 26, 0.06)");
    expect(lightTokens["overlay-soft"]).toBe("rgba(26, 26, 26, 0.1)");
    expect(lightTokens["overlay-medium"]).toBe("rgba(26, 26, 26, 0.16)");
    expect(lightTokens["overlay-strong"]).toBe("rgba(26, 26, 26, 0.22)");
    expect(lightTokens["overlay-emphasis"]).toBe("rgba(26, 26, 26, 0.3)");
  });

  it("sets lighter scrim defaults for light mode", () => {
    expect(lightTokens["scrim-soft"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(lightTokens["scrim-medium"]).toBe("rgba(0, 0, 0, 0.30)");
    expect(lightTokens["scrim-strong"]).toBe("rgba(0, 0, 0, 0.45)");
  });

  it("derives focus-ring from the theme's foreground ink for light mode", () => {
    expect(lightTokens["focus-ring"]).toBe("rgba(26, 26, 26, 0.2)");
  });

  it("derives new semantic token defaults for light mode", () => {
    expect(lightTokens["surface-input"]).toBe("#FFFFFF");
    expect(lightTokens["surface-inset"]).toBe("rgba(26, 26, 26, 0.04)");
    expect(lightTokens["surface-hover"]).toBe("rgba(26, 26, 26, 0.05)");
    expect(lightTokens["surface-active"]).toBe("rgba(26, 26, 26, 0.08)");
    expect(lightTokens["text-link"]).toBe("#3F9366");
    expect(lightTokens["border-interactive"]).toBe("rgba(26, 26, 26, 0.28)");
    expect(lightTokens["shadow-color"]).toBe("rgba(26, 26, 26, 0.1)");
  });

  it("Bondi overrides overlays to white-based for correct light-mode elevation", () => {
    const bondi = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === "bondi")!;
    expect(bondi.tokens["overlay-soft"]).toMatch(/^rgba\(255, 255, 255,/);
    expect(bondi.tokens["overlay-subtle"]).toMatch(/^rgba\(255, 255, 255,/);
  });
});

describe("createCanopyTokens — dark mode derived defaults match built-in", () => {
  const darkTokens = createCanopyTokens("dark", REQUIRED_TOKENS);

  it("sets white-based border defaults for dark mode", () => {
    expect(darkTokens["border-subtle"]).toBe("rgba(255, 255, 255, 0.08)");
    expect(darkTokens["border-strong"]).toBe("rgba(255, 255, 255, 0.14)");
    expect(darkTokens["border-divider"]).toBe("rgba(255, 255, 255, 0.05)");
  });

  it("sets white-based overlay defaults for dark mode", () => {
    expect(darkTokens["overlay-subtle"]).toBe("rgba(255, 255, 255, 0.02)");
    expect(darkTokens["overlay-emphasis"]).toBe("rgba(255, 255, 255, 0.1)");
  });

  it("sets standard scrim defaults for dark mode", () => {
    expect(darkTokens["scrim-soft"]).toBe("rgba(0, 0, 0, 0.2)");
    expect(darkTokens["scrim-medium"]).toBe("rgba(0, 0, 0, 0.45)");
    expect(darkTokens["scrim-strong"]).toBe("rgba(0, 0, 0, 0.62)");
  });

  it("derives new semantic token defaults for dark mode", () => {
    expect(darkTokens["surface-input"]).toBe(REQUIRED_TOKENS["surface-panel-elevated"]);
    expect(darkTokens["surface-inset"]).toBe("rgba(255, 255, 255, 0.03)");
    expect(darkTokens["surface-hover"]).toBe("rgba(255, 255, 255, 0.05)");
    expect(darkTokens["surface-active"]).toBe("rgba(255, 255, 255, 0.08)");
    expect(darkTokens["text-link"]).toBe("#3F9366");
    expect(darkTokens["border-interactive"]).toBe("rgba(255, 255, 255, 0.2)");
    expect(darkTokens["shadow-color"]).toBe("rgba(0, 0, 0, 0.5)");
  });
});

describe("createCanopyTokens — category color overrides", () => {
  it("uses default category colors when not overridden", () => {
    const tokens = createCanopyTokens("dark", REQUIRED_TOKENS);
    expect(tokens["category-blue"]).toBe("oklch(0.7 0.13 250)");
    expect(tokens["category-rose"]).toBe("oklch(0.7 0.14 5)");
    expect(tokens["category-slate"]).toBe("oklch(0.65 0.04 240)");
  });

  it("allows per-token category color overrides", () => {
    const tokens = createCanopyTokens("dark", {
      ...REQUIRED_TOKENS,
      "category-blue": "oklch(0.5 0.15 250)",
      "category-rose": "#ff0000",
    });
    expect(tokens["category-blue"]).toBe("oklch(0.5 0.15 250)");
    expect(tokens["category-rose"]).toBe("#ff0000");
    expect(tokens["category-green"]).toBe("oklch(0.7 0.13 145)");
  });
});

describe("createCanopyTokens — caller overrides win via spread", () => {
  it("explicit border-subtle in tokens overrides the dark default", () => {
    const tokens = createCanopyTokens("dark", {
      ...REQUIRED_TOKENS,
      "border-subtle": "rgba(100, 100, 100, 0.5)",
    });
    expect(tokens["border-subtle"]).toBe("rgba(100, 100, 100, 0.5)");
  });

  it("explicit overlay-emphasis in tokens overrides the light default", () => {
    const tokens = createCanopyTokens("light", {
      ...REQUIRED_TOKENS,
      "overlay-emphasis": "rgba(50, 50, 50, 0.2)",
    });
    expect(tokens["overlay-emphasis"]).toBe("rgba(50, 50, 50, 0.2)");
  });

  it("explicit surface-input overrides the default", () => {
    const tokens = createCanopyTokens("light", {
      ...REQUIRED_TOKENS,
      "surface-input": "#F0F0F0",
    });
    expect(tokens["surface-input"]).toBe("#F0F0F0");
  });

  it("explicit overrides win for all new semantic tokens", () => {
    const overrides = {
      "text-link": "#0000FF",
      "shadow-color": "rgba(10, 10, 10, 0.2)",
      "border-interactive": "#333333",
      "surface-inset": "#EEEEEE",
      "surface-hover": "rgba(0, 0, 0, 0.03)",
      "surface-active": "rgba(0, 0, 0, 0.06)",
    } as const;
    const tokens = createCanopyTokens("dark", { ...REQUIRED_TOKENS, ...overrides });
    for (const [key, value] of Object.entries(overrides)) {
      expect(tokens[key as keyof typeof tokens]).toBe(value);
    }
  });
});

describe("createCanopyTokens — accent-soft/muted branch by type", () => {
  it("uses higher alpha for dark accent-soft/muted", () => {
    const darkTokens = createCanopyTokens("dark", REQUIRED_TOKENS);
    expect(darkTokens["accent-soft"]).toBe("rgba(63, 147, 102, 0.18)");
    expect(darkTokens["accent-muted"]).toBe("rgba(63, 147, 102, 0.3)");
  });

  it("uses lower alpha for light accent-soft/muted", () => {
    const lightTokens = createCanopyTokens("light", REQUIRED_TOKENS);
    expect(lightTokens["accent-soft"]).toBe("rgba(63, 147, 102, 0.12)");
    expect(lightTokens["accent-muted"]).toBe("rgba(63, 147, 102, 0.2)");
  });
});

describe("createCanopyTokens — terminal fallbacks branch by type", () => {
  it("dark: terminal-black = surface-canvas, terminal-white = text-primary", () => {
    const darkTokens = createCanopyTokens("dark", REQUIRED_TOKENS);
    expect(darkTokens["terminal-black"]).toBe(REQUIRED_TOKENS["surface-canvas"]);
    expect(darkTokens["terminal-white"]).toBe(REQUIRED_TOKENS["text-primary"]);
  });

  it("light: terminal-black = text-primary, terminal-white = surface-canvas", () => {
    const lightTokens = createCanopyTokens("light", REQUIRED_TOKENS);
    expect(lightTokens["terminal-black"]).toBe(REQUIRED_TOKENS["text-primary"]);
    expect(lightTokens["terminal-white"]).toBe(REQUIRED_TOKENS["surface-canvas"]);
  });
});

describe("built-in schemes — Daintree has explicit category colors", () => {
  const canopy = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(canopy.tokens).toHaveProperty(key, expect.any(String));
    }
  });
});

describe("built-in schemes — Bondi light theme", () => {
  const bondi = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bondi")!;

  it("exists in BUILT_IN_APP_SCHEMES with type light", () => {
    expect(bondi).toBeDefined();
    expect(bondi.type).toBe("light");
    expect(bondi.builtin).toBe(true);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(bondi.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("delegates terminal-white to surface-canvas default", () => {
    expect(bondi.tokens["terminal-white"]).toBe(bondi.tokens["surface-canvas"]);
  });

  it("uses text-primary for syntax-punctuation (intentional)", () => {
    expect(bondi.tokens["syntax-punctuation"]).toBe(bondi.tokens["text-primary"]);
  });

  it("has corrected text-inverse (not same as text-primary)", () => {
    expect(bondi.tokens["text-inverse"]).not.toBe(bondi.tokens["text-primary"]);
  });

  it("passes critical contrast validation with no warnings", () => {
    expect(getAppThemeWarnings(bondi)).toEqual([]);
  });

  it.each([
    "terminal-red",
    "terminal-green",
    "terminal-yellow",
    "terminal-blue",
    "terminal-magenta",
    "terminal-cyan",
    "terminal-bright-red",
    "terminal-bright-green",
    "terminal-bright-yellow",
    "terminal-bright-blue",
    "terminal-bright-magenta",
    "terminal-bright-cyan",
    "terminal-bright-white",
    "terminal-black",
  ] as const)("%s meets WCAG AA 4.5:1 against surface-canvas", (token) => {
    const fg = bondi.tokens[token];
    const bg = bondi.tokens["surface-canvas"];
    const ratio = wcagContrastRatio(fg, bg);
    expect(
      ratio,
      `${token} "${fg}" on canvas "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    "syntax-keyword",
    "syntax-string",
    "syntax-function",
    "syntax-number",
    "syntax-comment",
    "syntax-punctuation",
    "syntax-operator",
    "syntax-link",
    "syntax-quote",
    "syntax-chip",
  ] as const)("%s meets WCAG AA 4.5:1 against canvas", (token) => {
    const fg = bondi.tokens[token];
    const bg = bondi.tokens["surface-canvas"];
    const ratio = wcagContrastRatio(fg, bg);
    expect(
      ratio,
      `${token} "${fg}" on canvas "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("text-primary meets WCAG AA on all surfaces", () => {
    const fg = bondi.tokens["text-primary"];
    for (const surface of [
      "surface-canvas",
      "surface-sidebar",
      "surface-panel",
      "surface-panel-elevated",
    ] as const) {
      const bg = bondi.tokens[surface];
      const ratio = wcagContrastRatio(fg, bg);
      expect(
        ratio,
        `text-primary on ${surface} "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("text-muted meets WCAG AA 3:1 against surface-panel and surface-canvas", () => {
    for (const surface of ["surface-panel", "surface-canvas"] as const) {
      const ratio = wcagContrastRatio(bondi.tokens["text-muted"], bondi.tokens[surface]);
      expect(
        ratio,
        `text-muted on ${surface} = ${ratio.toFixed(2)}:1, needs ≥3:1`
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("getBuiltInAppSchemeForType — returns Bondi for light", () => {
  it("returns the bondi scheme for light type", () => {
    const lightScheme = getBuiltInAppSchemeForType("light");
    expect(lightScheme.id).toBe("bondi");
    expect(lightScheme.type).toBe("light");
  });

  it("returns a dark scheme for dark type", () => {
    const darkScheme = getBuiltInAppSchemeForType("dark");
    expect(darkScheme.type).toBe("dark");
  });
});

describe("built-in schemes — Fiordland", () => {
  const fiordland = BUILT_IN_APP_SCHEMES.find((s) => s.id === "fiordland")!;

  it("exists with correct metadata", () => {
    expect(fiordland).toBeDefined();
    expect(fiordland.name).toBe("Fiordland");
    expect(fiordland.type).toBe("dark");
    expect(fiordland.builtin).toBe(true);
  });

  it("produces all 86 token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(fiordland.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("derives terminal-black from surface-canvas", () => {
    expect(fiordland.tokens["terminal-black"]).toBe(fiordland.tokens["surface-canvas"]);
  });

  it("derives terminal-white from text-primary", () => {
    expect(fiordland.tokens["terminal-white"]).toBe(fiordland.tokens["text-primary"]);
  });

  it("derives terminal-bright-black from activity-idle", () => {
    expect(fiordland.tokens["terminal-bright-black"]).toBe(fiordland.tokens["activity-idle"]);
  });

  it("passes contrast validation with no warnings", () => {
    expect(getAppThemeWarnings(fiordland)).toEqual([]);
  });
});

describe("built-in schemes — Galápagos", () => {
  const galapagos = BUILT_IN_APP_SCHEMES.find((s) => s.id === "galapagos")!;

  it("exists with correct metadata", () => {
    expect(galapagos).toBeDefined();
    expect(galapagos.name).toBe("Galápagos");
    expect(galapagos.type).toBe("dark");
    expect(galapagos.builtin).toBe(true);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(galapagos.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it.each([
    "terminal-red",
    "terminal-green",
    "terminal-yellow",
    "terminal-blue",
    "terminal-magenta",
    "terminal-cyan",
  ] as const)("%s meets WCAG 3:1 contrast against canvas", (token) => {
    const fg = galapagos.tokens[token];
    const bg = galapagos.tokens["surface-canvas"];
    const ratio = wcagContrastRatio(fg, bg);
    expect(
      ratio,
      `${token} "${fg}" on canvas "${bg}" = ${ratio.toFixed(2)}:1, needs ≥3:1`
    ).toBeGreaterThanOrEqual(3);
  });

  it("syntax-punctuation has ≥20% HSL lightness gap from syntax-comment", () => {
    function hslLightness(hex: string): number {
      const c = hex.replace("#", "");
      const r = parseInt(c.slice(0, 2), 16) / 255;
      const g = parseInt(c.slice(2, 4), 16) / 255;
      const b = parseInt(c.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return ((max + min) / 2) * 100;
    }
    const commentL = hslLightness(galapagos.tokens["syntax-comment"]);
    const punctuationL = hslLightness(galapagos.tokens["syntax-punctuation"]);
    expect(punctuationL - commentL).toBeGreaterThanOrEqual(20);
  });

  it("syntax-keyword and syntax-operator are in different hue families (≥50° apart)", () => {
    function hslHue(hex: string): number {
      const c = hex.replace("#", "");
      const r = parseInt(c.slice(0, 2), 16) / 255;
      const g = parseInt(c.slice(2, 4), 16) / 255;
      const b = parseInt(c.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      let h: number;
      if (max === r) h = ((g - b) / d + 6) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return h * 60;
    }
    const keywordHue = hslHue(galapagos.tokens["syntax-keyword"]);
    const operatorHue = hslHue(galapagos.tokens["syntax-operator"]);
    const hueDiff = Math.abs(keywordHue - operatorHue);
    const wrappedDiff = Math.min(hueDiff, 360 - hueDiff);
    expect(wrappedDiff).toBeGreaterThanOrEqual(50);
  });

  it("passes critical contrast checks without warnings", () => {
    expect(getAppThemeWarnings(galapagos)).toEqual([]);
  });
});

describe("built-in schemes — Highlands theme", () => {
  const highlands = BUILT_IN_APP_SCHEMES.find((s) => s.id === "highlands")!;

  it("exists with correct metadata", () => {
    expect(highlands).toBeDefined();
    expect(highlands.name).toBe("Highlands");
    expect(highlands.type).toBe("dark");
    expect(highlands.builtin).toBe(true);
  });

  it("derives terminal-black from surface-canvas", () => {
    expect(highlands.tokens["terminal-black"]).toBe(highlands.tokens["surface-canvas"]);
  });

  it("derives terminal-white from text-primary", () => {
    expect(highlands.tokens["terminal-white"]).toBe(highlands.tokens["text-primary"]);
  });

  it("derives terminal-bright-black from activity-idle", () => {
    expect(highlands.tokens["terminal-bright-black"]).toBe(highlands.tokens["activity-idle"]);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(highlands.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("passes critical contrast checks without warnings", () => {
    expect(getAppThemeWarnings(highlands)).toEqual([]);
  });
});

describe("built-in schemes — Namib theme", () => {
  const namib = BUILT_IN_APP_SCHEMES.find((s) => s.id === "namib")!;

  it("exists and is a dark builtin theme", () => {
    expect(namib).toBeDefined();
    expect(namib.type).toBe("dark");
    expect(namib.builtin).toBe(true);
  });

  it("derives terminal-black from surface-canvas", () => {
    expect(namib.tokens["terminal-black"]).toBe(namib.tokens["surface-canvas"]);
  });

  it("derives terminal-white from text-primary", () => {
    expect(namib.tokens["terminal-white"]).toBe(namib.tokens["text-primary"]);
  });

  it("produces all 86 required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(namib.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("has no contrast warnings", () => {
    expect(getAppThemeWarnings(namib)).toEqual([]);
  });
});

describe("built-in schemes — Arashiyama bamboo-grove dark theme", () => {
  const arashiyama = BUILT_IN_APP_SCHEMES.find((s) => s.id === "arashiyama")!;

  it("exists with correct metadata", () => {
    expect(arashiyama).toBeDefined();
    expect(arashiyama.name).toBe("Arashiyama");
    expect(arashiyama.type).toBe("dark");
    expect(arashiyama.builtin).toBe(true);
  });

  it("terminal-selection passes 3:1 contrast against canvas", () => {
    const ratio = wcagContrastRatio(
      arashiyama.tokens["terminal-selection"],
      arashiyama.tokens["surface-canvas"]
    );
    expect(ratio, `selection contrast ${ratio.toFixed(2)}:1 needs ≥3:1`).toBeGreaterThanOrEqual(3);
  });

  it("syntax-number is distinct from syntax-string", () => {
    expect(arashiyama.tokens["syntax-number"]).not.toBe(arashiyama.tokens["syntax-string"]);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(arashiyama.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("passes contrast validation with no warnings", () => {
    expect(getAppThemeWarnings(arashiyama)).toEqual([]);
  });
});

describe("built-in schemes — Redwoods has correct tokens and derived values", () => {
  const redwoods = BUILT_IN_APP_SCHEMES.find((s) => s.id === "redwoods")!;

  it("exists as a dark builtin scheme", () => {
    expect(redwoods).toBeDefined();
    expect(redwoods.type).toBe("dark");
    expect(redwoods.builtin).toBe(true);
  });

  it("derives terminal-black from surface-canvas", () => {
    expect(redwoods.tokens["terminal-black"]).toBe(redwoods.tokens["surface-canvas"]);
  });

  it("derives terminal-white from text-primary", () => {
    expect(redwoods.tokens["terminal-white"]).toBe(redwoods.tokens["text-primary"]);
  });

  it("derives terminal-bright-black from activity-idle", () => {
    expect(redwoods.tokens["terminal-bright-black"]).toBe(redwoods.tokens["activity-idle"]);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(redwoods.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("passes getAppThemeWarnings with no contrast violations", () => {
    expect(getAppThemeWarnings(redwoods)).toEqual([]);
  });
});

describe("built-in schemes — Serengeti light theme", () => {
  const serengeti = BUILT_IN_APP_SCHEMES.find((s) => s.id === "serengeti")!;

  it("exists in BUILT_IN_APP_SCHEMES as a light builtin", () => {
    expect(serengeti).toBeDefined();
    expect(serengeti.type).toBe("light");
    expect(serengeti.builtin).toBe(true);
  });

  it("produces all 86 required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(serengeti.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("terminal-black is not surface-canvas (overridden to text-primary)", () => {
    expect(serengeti.tokens["terminal-black"]).not.toBe(serengeti.tokens["surface-canvas"]);
  });

  it("syntax-comment is distinct from text-muted", () => {
    expect(serengeti.tokens["syntax-comment"]).not.toBe(serengeti.tokens["text-muted"]);
  });

  it("syntax-function differs from accent-primary", () => {
    expect(serengeti.tokens["syntax-function"]).not.toBe(serengeti.tokens["accent-primary"]);
  });

  it("passes critical-pair WCAG contrast checks (zero warnings)", () => {
    expect(getAppThemeWarnings(serengeti)).toEqual([]);
  });

  it.each([
    "syntax-keyword",
    "syntax-string",
    "syntax-function",
    "syntax-number",
    "syntax-comment",
    "syntax-punctuation",
    "syntax-operator",
    "syntax-link",
    "syntax-quote",
    "syntax-chip",
  ] as const)("%s meets WCAG AA 4.5:1 against canvas", (token) => {
    const fg = serengeti.tokens[token];
    const bg = serengeti.tokens["surface-canvas"];
    const ratio = wcagContrastRatio(fg, bg);
    expect(
      ratio,
      `${token} "${fg}" on canvas "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("delegates terminal-white and terminal-bright-black to defaults", () => {
    expect(serengeti.tokens["terminal-white"]).toBe(serengeti.tokens["surface-canvas"]);
    expect(serengeti.tokens["terminal-bright-black"]).toBe(serengeti.tokens["activity-idle"]);
  });

  it("text-muted meets WCAG AA 3:1 against surface-panel", () => {
    const ratio = wcagContrastRatio(
      serengeti.tokens["text-muted"],
      serengeti.tokens["surface-panel"]
    );
    expect(
      ratio,
      `text-muted on surface-panel = ${ratio.toFixed(2)}:1, needs ≥3:1`
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("Hokkaido built-in scheme", () => {
  const hokkaido = BUILT_IN_APP_SCHEMES.find((s) => s.id === "hokkaido")!;

  it("is present in BUILT_IN_APP_SCHEMES with correct metadata", () => {
    expect(hokkaido).toBeDefined();
    expect(hokkaido.name).toBe("Hokkaido");
    expect(hokkaido.type).toBe("light");
    expect(hokkaido.builtin).toBe(true);
  });

  it("uses theme-appropriate activity indicators instead of neon green", () => {
    expect(hokkaido.tokens["activity-active"]).not.toBe("#22c55e");
    expect(hokkaido.tokens["activity-working"]).not.toBe("#22c55e");
    expect(hokkaido.tokens["activity-waiting"]).not.toBe("#d97706");
  });

  it("has all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(hokkaido.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("passes all critical contrast pair validations", () => {
    expect(getAppThemeWarnings(hokkaido)).toEqual([]);
  });

  it.each([
    "syntax-keyword",
    "syntax-string",
    "syntax-comment",
    "syntax-number",
    "syntax-operator",
    "syntax-function",
    "syntax-punctuation",
    "syntax-quote",
  ] as const)("%s meets WCAG AA 4.5:1 on canvas", (token) => {
    const fg = hokkaido.tokens[token];
    const bg = hokkaido.tokens["surface-canvas"];
    const ratio = wcagContrastRatio(fg, bg);
    expect(
      ratio,
      `${token} "${fg}" on canvas "${bg}" = ${ratio.toFixed(2)}:1, needs ≥4.5:1`
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("built-in schemes — Svalbard light theme", () => {
  const svalbard = BUILT_IN_APP_SCHEMES.find((s) => s.id === "svalbard")!;

  it("exists with correct metadata", () => {
    expect(svalbard).toBeDefined();
    expect(svalbard.id).toBe("svalbard");
    expect(svalbard.name).toBe("Svalbard");
    expect(svalbard.type).toBe("light");
    expect(svalbard.builtin).toBe(true);
  });

  it("auto-derives terminal-black from text-primary for light themes", () => {
    expect(svalbard.tokens["terminal-black"]).toBe(svalbard.tokens["text-primary"]);
  });

  it("auto-derives terminal-white from surface-canvas for light themes", () => {
    expect(svalbard.tokens["terminal-white"]).toBe(svalbard.tokens["surface-canvas"]);
  });

  it("auto-derives terminal-bright-black from activity-idle", () => {
    expect(svalbard.tokens["terminal-bright-black"]).toBe(svalbard.tokens["activity-idle"]);
  });

  it("sidebar vs canvas contrast ≥ 1.08", () => {
    const ratio = wcagContrastRatio(
      svalbard.tokens["surface-sidebar"],
      svalbard.tokens["surface-canvas"]
    );
    expect(ratio).toBeGreaterThanOrEqual(1.08);
  });

  it("border-default vs canvas contrast ≥ 1.2", () => {
    const ratio = wcagContrastRatio(
      svalbard.tokens["border-default"],
      svalbard.tokens["surface-canvas"]
    );
    expect(ratio).toBeGreaterThanOrEqual(1.2);
  });

  it("panel vs grid contrast ≥ 1.05", () => {
    const ratio = wcagContrastRatio(
      svalbard.tokens["surface-panel"],
      svalbard.tokens["surface-grid"]
    );
    expect(ratio).toBeGreaterThanOrEqual(1.05);
  });

  it("text-primary meets WCAG AA (≥ 4.5:1) on panel", () => {
    const ratio = wcagContrastRatio(
      svalbard.tokens["text-primary"],
      svalbard.tokens["surface-panel"]
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(svalbard.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("passes all critical contrast checks", () => {
    expect(getAppThemeWarnings(svalbard)).toEqual([]);
  });
});

describe("built-in schemes — Hokkaido light terminal fallbacks", () => {
  const hokkaido = BUILT_IN_APP_SCHEMES.find((s) => s.id === "hokkaido")!;

  it("auto-derives terminal-black from text-primary for light themes", () => {
    expect(hokkaido.tokens["terminal-black"]).toBe(hokkaido.tokens["text-primary"]);
  });

  it("auto-derives terminal-white from surface-canvas for light themes", () => {
    expect(hokkaido.tokens["terminal-white"]).toBe(hokkaido.tokens["surface-canvas"]);
  });
});

describe("normalizeAppColorScheme", () => {
  it("uses a light fallback base for partial light themes", () => {
    const scheme = normalizeAppColorScheme({
      id: "custom-light",
      name: "Custom Light",
      type: "light",
      tokens: {
        "surface-canvas": "#ffffff",
      } as Partial<AppColorSchemeTokens> as AppColorSchemeTokens,
    });

    expect(scheme.type).toBe("light");
    expect(scheme.tokens["surface-canvas"]).toBe("#ffffff");
    expect(scheme.tokens["surface-panel"]).not.toBe(
      BUILT_IN_APP_SCHEMES[0].tokens["surface-panel"]
    );
    expect(scheme.tokens["surface-panel"]).toBe(
      getBuiltInAppSchemeForType("light").tokens["surface-panel"]
    );
  });

  it("fills in new semantic tokens for dark custom themes missing them", () => {
    const scheme = normalizeAppColorScheme({
      id: "legacy-custom",
      name: "Legacy Custom",
      type: "dark",
      tokens: {
        "surface-canvas": "#1a1a1a",
      } as Partial<AppColorSchemeTokens> as AppColorSchemeTokens,
    });

    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(scheme.tokens).toHaveProperty(key, expect.any(String));
    }
    const daintree = BUILT_IN_APP_SCHEMES[0];
    expect(scheme.tokens["surface-input"]).toBe(daintree.tokens["surface-input"]);
    expect(scheme.tokens["shadow-color"]).toBe(daintree.tokens["shadow-color"]);
    expect(scheme.tokens["text-link"]).toBe(daintree.tokens["text-link"]);
  });

  it("fills in light-specific defaults for light custom themes missing new tokens", () => {
    const scheme = normalizeAppColorScheme({
      id: "legacy-light",
      name: "Legacy Light",
      type: "light",
      tokens: {
        "surface-canvas": "#ffffff",
      } as Partial<AppColorSchemeTokens> as AppColorSchemeTokens,
    });

    const lightBase = getBuiltInAppSchemeForType("light");
    expect(scheme.tokens["surface-input"]).toBe(lightBase.tokens["surface-input"]);
    expect(scheme.tokens["shadow-color"]).toBe(lightBase.tokens["shadow-color"]);
    expect(scheme.tokens["text-link"]).toBe(lightBase.tokens["text-link"]);
  });
});

describe("built-in schemes — Atacama light theme", () => {
  const atacama = BUILT_IN_APP_SCHEMES.find((s) => s.id === "atacama")!;

  it("exists in BUILT_IN_APP_SCHEMES as a light theme", () => {
    expect(atacama).toBeDefined();
    expect(atacama.type).toBe("light");
    expect(atacama.builtin).toBe(true);
  });

  it("is retrievable via getAppThemeById", () => {
    expect(getAppThemeById("atacama")).toBe(atacama);
  });

  it("auto-derives terminal-black from text-primary for light themes", () => {
    expect(atacama.tokens["terminal-black"]).toBe(atacama.tokens["text-primary"]);
  });

  it("auto-derives terminal-white from surface-canvas for light themes", () => {
    expect(atacama.tokens["terminal-white"]).toBe(atacama.tokens["surface-canvas"]);
  });

  it("auto-derives terminal-bright-black from activity-idle", () => {
    expect(atacama.tokens["terminal-bright-black"]).toBe(atacama.tokens["activity-idle"]);
  });

  it("syntax-operator is distinct from syntax-keyword", () => {
    expect(atacama.tokens["syntax-operator"]).not.toBe(atacama.tokens["syntax-keyword"]);
  });

  it("produces all required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(atacama.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("passes all critical contrast checks", () => {
    expect(getAppThemeWarnings(atacama)).toEqual([]);
  });

  it("has unique ID in BUILT_IN_APP_SCHEMES", () => {
    const ids = BUILT_IN_APP_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function oklchLightness(hex: string): number {
  function toLinear(ch: number): number {
    const n = ch / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  }
  const c = hex.replace("#", "");
  const e =
    c.length === 3
      ? c
          .split("")
          .map((ch) => `${ch}${ch}`)
          .join("")
      : c;
  const r = toLinear(parseInt(e.slice(0, 2), 16));
  const g = toLinear(parseInt(e.slice(2, 4), 16));
  const b = toLinear(parseInt(e.slice(4, 6), 16));
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188976 * g + 0.6299786405 * b;
  const lp = Math.cbrt(l),
    mp = Math.cbrt(m),
    sp = Math.cbrt(s);
  return 0.2104542553 * lp + 0.793617785 * mp - 0.0040720468 * sp;
}

const LIGHT_THEME_IDS = ["atacama", "serengeti", "hokkaido", "svalbard"] as const;

const ANSI_FOREGROUND_KEYS = [
  "terminal-red",
  "terminal-green",
  "terminal-yellow",
  "terminal-blue",
  "terminal-magenta",
  "terminal-cyan",
  "terminal-bright-red",
  "terminal-bright-green",
  "terminal-bright-yellow",
  "terminal-bright-blue",
  "terminal-bright-magenta",
  "terminal-bright-cyan",
  "terminal-bright-white",
  "terminal-black",
] as const;

describe("light theme surface OKLCH L deltas (>= 0.02)", () => {
  for (const id of LIGHT_THEME_IDS) {
    const theme = BUILT_IN_APP_SCHEMES.find((s) => s.id === id)!;

    it(`${id}: sidebar → canvas delta >= 0.02`, () => {
      const delta = Math.abs(
        oklchLightness(theme.tokens["surface-canvas"]) -
          oklchLightness(theme.tokens["surface-sidebar"])
      );
      expect(delta, `${id} sidebar→canvas delta ${delta.toFixed(4)}`).toBeGreaterThanOrEqual(0.02);
    });

    it(`${id}: canvas → panel delta >= 0.02`, () => {
      const delta = Math.abs(
        oklchLightness(theme.tokens["surface-panel"]) -
          oklchLightness(theme.tokens["surface-canvas"])
      );
      expect(delta, `${id} canvas→panel delta ${delta.toFixed(4)}`).toBeGreaterThanOrEqual(0.02);
    });

    it(`${id}: panel → elevated delta >= 0.02`, () => {
      const delta = Math.abs(
        oklchLightness(theme.tokens["surface-panel-elevated"]) -
          oklchLightness(theme.tokens["surface-panel"])
      );
      expect(delta, `${id} panel→elevated delta ${delta.toFixed(4)}`).toBeGreaterThanOrEqual(0.02);
    });
  }
});

describe("light theme ANSI terminal colors meet WCAG AA 4.5:1 on panel", () => {
  for (const id of LIGHT_THEME_IDS) {
    const theme = BUILT_IN_APP_SCHEMES.find((s) => s.id === id)!;
    const panel = theme.tokens["surface-panel"];

    for (const key of ANSI_FOREGROUND_KEYS) {
      it(`${id}: ${key} meets 4.5:1 on panel`, () => {
        const fg = theme.tokens[key];
        const ratio = wcagContrastRatio(fg, panel);
        expect(
          ratio,
          `${id} ${key} "${fg}" on panel "${panel}" = ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("light theme terminal-bright-black meets 3:1 on panel", () => {
  for (const id of LIGHT_THEME_IDS) {
    const theme = BUILT_IN_APP_SCHEMES.find((s) => s.id === id)!;
    const panel = theme.tokens["surface-panel"];

    it(`${id}: terminal-bright-black meets 3:1 on panel`, () => {
      const fg = theme.tokens["terminal-bright-black"];
      const ratio = wcagContrastRatio(fg, panel);
      expect(
        ratio,
        `${id} terminal-bright-black "${fg}" on panel "${panel}" = ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("warm dark themes have tinted shadow-color", () => {
  it.each(["arashiyama", "highlands", "namib", "redwoods"] as const)(
    "%s has explicit shadow-color override (not default rgba(0,0,0,0.5))",
    (id) => {
      const theme = BUILT_IN_APP_SCHEMES.find((s) => s.id === id)!;
      expect(theme.tokens["shadow-color"]).not.toBe("rgba(0, 0, 0, 0.5)");
      expect(theme.tokens["shadow-color"]).toMatch(/^rgba\(/);
    }
  );
});

describe("all 11 themes pass text-primary contrast on all surfaces", () => {
  for (const theme of BUILT_IN_APP_SCHEMES) {
    const surfaces = [
      "surface-canvas",
      "surface-panel",
      "surface-panel-elevated",
      "surface-sidebar",
    ] as const;
    for (const surface of surfaces) {
      it(`${theme.id}: text-primary on ${surface} >= 4.5:1`, () => {
        const fg = theme.tokens["text-primary"];
        const bg = theme.tokens[surface];
        if (!/^#/.test(fg) || !/^#/.test(bg)) return;
        const ratio = wcagContrastRatio(fg, bg);
        expect(
          ratio,
          `${theme.id} text-primary on ${surface} = ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("getAppThemeWarnings", () => {
  it("reports low-contrast critical token pairs", () => {
    const scheme = normalizeAppColorScheme({
      id: "low-contrast",
      name: "Low Contrast",
      type: "dark",
      tokens: {
        "surface-canvas": "#202020",
        "surface-panel": "#202020",
        "surface-panel-elevated": "#202020",
        "surface-sidebar": "#202020",
        "text-primary": "#444444",
        "accent-primary": "#555555",
        "accent-foreground": "#666666",
      } as Partial<AppColorSchemeTokens> as AppColorSchemeTokens,
    });

    expect(getAppThemeWarnings(scheme)).not.toEqual([]);
  });
});

describe("legacy app scheme ID aliasing", () => {
  it("DEFAULT_APP_SCHEME_ID is daintree", () => {
    expect(DEFAULT_APP_SCHEME_ID).toBe("daintree");
  });

  it('getAppThemeById("canopy") resolves to daintree via alias, not fallback', () => {
    const scheme = getAppThemeById("canopy");
    expect(scheme).toBeDefined();
    expect(scheme!.id).toBe("daintree");
  });

  it('getAppThemeById("canopy-slate") resolves to daintree via alias', () => {
    const scheme = getAppThemeById("canopy-slate");
    expect(scheme).toBeDefined();
    expect(scheme!.id).toBe("daintree");
  });

  it("getAppThemeById returns undefined for unknown IDs (not fallback)", () => {
    expect(getAppThemeById("nonexistent")).toBeUndefined();
  });

  it('resolveAppTheme("daintree") returns the daintree scheme', () => {
    const scheme = resolveAppTheme("daintree");
    expect(scheme.id).toBe("daintree");
  });

  it("removed IDs are not present in BUILT_IN_APP_SCHEMES", () => {
    const ids = BUILT_IN_APP_SCHEMES.map((s) => s.id);
    expect(ids).not.toContain("canopy");
    expect(ids).not.toContain("canopy-slate");
    expect(ids).toContain("daintree");
  });
});
