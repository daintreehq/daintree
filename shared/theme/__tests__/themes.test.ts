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
    expect(lightTokens["border-subtle"]).toBe("rgba(26, 26, 26, 0.12)");
    expect(lightTokens["border-strong"]).toBe("rgba(26, 26, 26, 0.2)");
    expect(lightTokens["border-divider"]).toBe("rgba(26, 26, 26, 0.08)");
  });

  it("derives overlay defaults from the theme's foreground ink for light mode", () => {
    expect(lightTokens["overlay-subtle"]).toBe("rgba(26, 26, 26, 0.04)");
    expect(lightTokens["overlay-soft"]).toBe("rgba(26, 26, 26, 0.08)");
    expect(lightTokens["overlay-medium"]).toBe("rgba(26, 26, 26, 0.12)");
    expect(lightTokens["overlay-strong"]).toBe("rgba(26, 26, 26, 0.16)");
    expect(lightTokens["overlay-emphasis"]).toBe("rgba(26, 26, 26, 0.2)");
  });

  it("sets lighter scrim defaults for light mode", () => {
    expect(lightTokens["scrim-soft"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(lightTokens["scrim-medium"]).toBe("rgba(0, 0, 0, 0.30)");
    expect(lightTokens["scrim-strong"]).toBe("rgba(0, 0, 0, 0.45)");
  });

  it("derives focus-ring from the theme's foreground ink for light mode", () => {
    expect(lightTokens["focus-ring"]).toBe("rgba(26, 26, 26, 0.2)");
  });

  it("keeps the default Bondi overlays warm instead of neutral black", () => {
    const bondi = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === "bondi")!;
    expect(bondi.tokens["overlay-soft"]).toBe("rgba(27, 54, 38, 0.08)");
    expect(bondi.tokens["border-divider"]).toBe("rgba(27, 54, 38, 0.08)");
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

  it("has all 12 category colors set", () => {
    expect(canopy.tokens["category-blue"]).toBe("oklch(0.7 0.13 250)");
    expect(canopy.tokens["category-purple"]).toBe("oklch(0.7 0.13 310)");
    expect(canopy.tokens["category-cyan"]).toBe("oklch(0.72 0.11 215)");
    expect(canopy.tokens["category-green"]).toBe("oklch(0.7 0.13 145)");
    expect(canopy.tokens["category-amber"]).toBe("oklch(0.73 0.14 75)");
    expect(canopy.tokens["category-orange"]).toBe("oklch(0.7 0.14 45)");
    expect(canopy.tokens["category-teal"]).toBe("oklch(0.7 0.11 185)");
    expect(canopy.tokens["category-indigo"]).toBe("oklch(0.7 0.13 275)");
    expect(canopy.tokens["category-rose"]).toBe("oklch(0.7 0.14 5)");
    expect(canopy.tokens["category-pink"]).toBe("oklch(0.72 0.13 340)");
    expect(canopy.tokens["category-violet"]).toBe("oklch(0.7 0.13 295)");
    expect(canopy.tokens["category-slate"]).toBe("oklch(0.65 0.04 240)");
  });

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

  it("has explicitly overridden terminal-black and terminal-white", () => {
    expect(bondi.tokens["terminal-black"]).toBe("#1B3626");
    expect(bondi.tokens["terminal-white"]).toBe("#6E746D");
  });

  it("has the correct accent-primary", () => {
    expect(bondi.tokens["accent-primary"]).toBe("#3F9366");
  });

  it("has sandstone cream canvas", () => {
    expect(bondi.tokens["surface-canvas"]).toBe("#F6F0E4");
  });

  it("uses stronger light chrome tokens to keep cards and inputs separated", () => {
    expect(bondi.tokens["surface-sidebar"]).toBe("#E5DDCF");
    expect(bondi.tokens["surface-panel"]).toBe("#FFF9F1");
    expect(bondi.tokens["surface-panel-elevated"]).toBe("#FFFDF9");
    expect(bondi.tokens["text-muted"]).toBe("#6E746D");
    expect(bondi.tokens["border-default"]).toBe("#CFC4B3");
  });

  it("uses lower oklch lightness for category colors", () => {
    expect(bondi.tokens["category-blue"]).toBe("oklch(0.62 0.14 250)");
    expect(bondi.tokens["category-slate"]).toBe("oklch(0.58 0.04 240)");
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

  it("produces all 79 token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(fiordland.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("uses the brand accent-primary", () => {
    expect(fiordland.tokens["accent-primary"]).toBe("#3F9366");
  });

  it("derives accent-foreground from text-inverse", () => {
    expect(fiordland.tokens["accent-foreground"]).toBe("#070D12");
  });

  it("uses contrast-safe status-danger", () => {
    expect(fiordland.tokens["status-danger"]).toBe("#E04055");
  });

  it("overrides overlay tokens for deep background", () => {
    expect(fiordland.tokens["overlay-subtle"]).toBe("rgba(255, 255, 255, 0.03)");
    expect(fiordland.tokens["overlay-soft"]).toBe("rgba(255, 255, 255, 0.05)");
    expect(fiordland.tokens["overlay-medium"]).toBe("rgba(255, 255, 255, 0.08)");
    expect(fiordland.tokens["overlay-strong"]).toBe("rgba(255, 255, 255, 0.12)");
    expect(fiordland.tokens["overlay-emphasis"]).toBe("rgba(255, 255, 255, 0.18)");
  });

  it("derives terminal-black from surface-canvas", () => {
    expect(fiordland.tokens["terminal-black"]).toBe("#070D12");
  });

  it("derives terminal-white from text-primary", () => {
    expect(fiordland.tokens["terminal-white"]).toBe("#D4E0D6");
  });

  it("derives terminal-bright-black from activity-idle", () => {
    expect(fiordland.tokens["terminal-bright-black"]).toBe("#3D4E5C");
  });

  it("has all 12 category colors set", () => {
    expect(fiordland.tokens["category-blue"]).toBe("oklch(0.7 0.13 250)");
    expect(fiordland.tokens["category-purple"]).toBe("oklch(0.7 0.13 310)");
    expect(fiordland.tokens["category-cyan"]).toBe("oklch(0.72 0.11 215)");
    expect(fiordland.tokens["category-green"]).toBe("oklch(0.7 0.13 145)");
    expect(fiordland.tokens["category-amber"]).toBe("oklch(0.73 0.14 75)");
    expect(fiordland.tokens["category-orange"]).toBe("oklch(0.7 0.14 45)");
    expect(fiordland.tokens["category-teal"]).toBe("oklch(0.7 0.11 185)");
    expect(fiordland.tokens["category-indigo"]).toBe("oklch(0.7 0.13 275)");
    expect(fiordland.tokens["category-rose"]).toBe("oklch(0.7 0.14 5)");
    expect(fiordland.tokens["category-pink"]).toBe("oklch(0.72 0.13 340)");
    expect(fiordland.tokens["category-violet"]).toBe("oklch(0.7 0.13 295)");
    expect(fiordland.tokens["category-slate"]).toBe("oklch(0.65 0.04 240)");
  });

  it("passes contrast validation with no warnings", () => {
    expect(getAppThemeWarnings(fiordland)).toEqual([]);
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

  it("preserves mandatory eucalyptus accent", () => {
    expect(highlands.tokens["accent-primary"]).toBe("#3F9366");
  });

  it("uses contrast-adjusted syntax colors", () => {
    expect(highlands.tokens["syntax-keyword"]).toBe("#B872A5");
    expect(highlands.tokens["syntax-function"]).toBe("#6898B5");
    expect(highlands.tokens["syntax-number"]).toBe("#BE7055");
    expect(highlands.tokens["status-danger"]).toBe("#E35040");
  });

  it("auto-derives terminal-black/white/bright-black from surfaces and activity", () => {
    expect(highlands.tokens["terminal-black"]).toBe("#1A1614");
    expect(highlands.tokens["terminal-white"]).toBe("#C9D1D9");
    expect(highlands.tokens["terminal-bright-black"]).toBe("#4A4238");
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

  it("has the correct accent and canvas colors", () => {
    expect(namib.tokens["accent-primary"]).toBe("#3F9366");
    expect(namib.tokens["surface-canvas"]).toBe("#1C0F0B");
  });

  it("has the scarab cyan keyword color", () => {
    expect(namib.tokens["syntax-keyword"]).toBe("#48C0B2");
  });

  it("derives terminal-black/white/bright-black from surfaces and activity", () => {
    expect(namib.tokens["terminal-black"]).toBe(namib.tokens["surface-canvas"]);
    expect(namib.tokens["terminal-white"]).toBe(namib.tokens["text-primary"]);
    expect(namib.tokens["terminal-bright-black"]).toBe(namib.tokens["activity-idle"]);
  });

  it("produces all 79 required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(namib.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("has no contrast warnings", () => {
    expect(getAppThemeWarnings(namib)).toEqual([]);
  });
});

describe("built-in schemes — Redwoods has correct tokens and derived values", () => {
  const redwoods = BUILT_IN_APP_SCHEMES.find((s) => s.id === "redwoods")!;

  it("exists as a dark builtin scheme", () => {
    expect(redwoods).toBeDefined();
    expect(redwoods.type).toBe("dark");
    expect(redwoods.builtin).toBe(true);
  });

  it("has the shared brand accent", () => {
    expect(redwoods.tokens["accent-primary"]).toBe("#3F9366");
  });

  it("derives terminal-black from surface-canvas", () => {
    expect(redwoods.tokens["terminal-black"]).toBe("#1A1210");
  });

  it("derives terminal-white from text-primary", () => {
    expect(redwoods.tokens["terminal-white"]).toBe("#D4C5B8");
  });

  it("derives terminal-bright-black from activity-idle", () => {
    expect(redwoods.tokens["terminal-bright-black"]).toBe("#52423D");
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

  it("produces all 79 required token keys", () => {
    for (const key of APP_THEME_TOKEN_KEYS) {
      expect(serengeti.tokens).toHaveProperty(key, expect.any(String));
    }
  });

  it("overrides terminal-black to text-primary, not surface-canvas", () => {
    expect(serengeti.tokens["terminal-black"]).toBe("#4A3F35");
    expect(serengeti.tokens["terminal-black"]).not.toBe(serengeti.tokens["surface-canvas"]);
  });

  it("syntax-comment is distinct from text-muted", () => {
    expect(serengeti.tokens["syntax-comment"]).toBe("#6E6259");
    expect(serengeti.tokens["text-muted"]).toBe("#7A6E63");
    expect(serengeti.tokens["syntax-comment"]).not.toBe(serengeti.tokens["text-muted"]);
  });

  it("syntax-function differs from accent-primary", () => {
    expect(serengeti.tokens["accent-primary"]).toBe("#3F9366");
    expect(serengeti.tokens["syntax-function"]).toBe("#256645");
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
    expect(serengeti.tokens["terminal-bright-white"]).toBe("#2A2018");
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

  it("uses earthy activity colors instead of neon", () => {
    expect(serengeti.tokens["activity-active"]).toBe("#1D9B5E");
    expect(serengeti.tokens["activity-working"]).toBe("#1D9B5E");
    expect(serengeti.tokens["activity-waiting"]).toBe("#C17F2E");
    expect(serengeti.tokens["activity-idle"]).toBe("#8C8782");
  });

  it("uses lower-lightness oklch category colors for light mode", () => {
    expect(serengeti.tokens["category-blue"]).toBe("oklch(0.62 0.14 250)");
    expect(serengeti.tokens["category-slate"]).toBe("oklch(0.58 0.04 240)");
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

  it("uses the fixed brand accent-primary", () => {
    expect(hokkaido.tokens["accent-primary"]).toBe("#3F9366");
  });

  it("uses the cool grey-white canvas", () => {
    expect(hokkaido.tokens["surface-canvas"]).toBe("#F4F7F9");
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
    ["syntax-keyword", "#795293", 4.5],
    ["syntax-string", "#B94665", 4.5],
    ["syntax-comment", "#5A7485", 4.5],
    ["syntax-number", "#2E5E82", 4.5],
    ["syntax-operator", "#006A71", 4.5],
    ["syntax-function", "#2D7A52", 4.5],
    ["syntax-punctuation", "#3A4D5C", 4.5],
  ] as const)("%s (%s) meets WCAG AA contrast (≥%s:1) on canvas", (token, _hex, minimum) => {
    const fg = hokkaido.tokens[token];
    const bg = hokkaido.tokens["surface-canvas"];
    const ratio = wcagContrastRatio(fg, bg);
    expect(
      ratio,
      `${token} "${fg}" on canvas "${bg}" = ${ratio.toFixed(2)}:1, needs ≥${minimum}:1`
    ).toBeGreaterThanOrEqual(minimum);
  });
});

describe("built-in schemes — Svalbard light terminal fallbacks", () => {
  const svalbard = BUILT_IN_APP_SCHEMES.find((s) => s.id === "svalbard")!;

  it("auto-derives terminal-black from text-primary for light themes", () => {
    expect(svalbard.tokens["terminal-black"]).toBe(svalbard.tokens["text-primary"]);
  });

  it("auto-derives terminal-white from surface-canvas for light themes", () => {
    expect(svalbard.tokens["terminal-white"]).toBe(svalbard.tokens["surface-canvas"]);
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

  it("uses WCAG-safe text-muted (#6B6560), not the original #9A9386", () => {
    expect(atacama.tokens["text-muted"]).toBe("#6B6560");
  });

  it("has accent-foreground explicitly set", () => {
    expect(atacama.tokens["accent-foreground"]).toBe("#08140e");
  });

  it("has near-black terminal-bright-white for light background", () => {
    expect(atacama.tokens["terminal-bright-white"]).toBe("#1A1210");
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

  it("has signature indigo keywords and teal functions", () => {
    expect(atacama.tokens["syntax-keyword"]).toBe("#293D71");
    expect(atacama.tokens["syntax-function"]).toBe("#1B5F5C");
  });

  it("has correct mineral-desert surface hierarchy", () => {
    expect(atacama.tokens["surface-canvas"]).toBe("#F4F4F2");
    expect(atacama.tokens["surface-panel"]).toBe("#FAFAF8");
    expect(atacama.tokens["surface-panel-elevated"]).toBe("#FFFFFF");
  });

  it("has light-appropriate category colors (oklch L=0.58-0.68)", () => {
    expect(atacama.tokens["category-blue"]).toBe("oklch(0.62 0.14 250)");
    expect(atacama.tokens["category-purple"]).toBe("oklch(0.64 0.14 310)");
    expect(atacama.tokens["category-cyan"]).toBe("oklch(0.65 0.12 215)");
    expect(atacama.tokens["category-green"]).toBe("oklch(0.63 0.13 145)");
    expect(atacama.tokens["category-amber"]).toBe("oklch(0.68 0.14 75)");
    expect(atacama.tokens["category-orange"]).toBe("oklch(0.66 0.15 45)");
    expect(atacama.tokens["category-teal"]).toBe("oklch(0.64 0.11 185)");
    expect(atacama.tokens["category-indigo"]).toBe("oklch(0.61 0.13 275)");
    expect(atacama.tokens["category-rose"]).toBe("oklch(0.63 0.14 5)");
    expect(atacama.tokens["category-pink"]).toBe("oklch(0.66 0.13 340)");
    expect(atacama.tokens["category-violet"]).toBe("oklch(0.63 0.13 295)");
    expect(atacama.tokens["category-slate"]).toBe("oklch(0.58 0.04 240)");
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
