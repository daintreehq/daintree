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

  it("sets black-based border defaults for light mode", () => {
    expect(lightTokens["border-subtle"]).toBe("rgba(0, 0, 0, 0.06)");
    expect(lightTokens["border-strong"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(lightTokens["border-divider"]).toBe("rgba(0, 0, 0, 0.05)");
  });

  it("sets black-based overlay defaults for light mode", () => {
    expect(lightTokens["overlay-subtle"]).toBe("rgba(0, 0, 0, 0.02)");
    expect(lightTokens["overlay-soft"]).toBe("rgba(0, 0, 0, 0.03)");
    expect(lightTokens["overlay-medium"]).toBe("rgba(0, 0, 0, 0.04)");
    expect(lightTokens["overlay-strong"]).toBe("rgba(0, 0, 0, 0.05)");
    expect(lightTokens["overlay-emphasis"]).toBe("rgba(0, 0, 0, 0.08)");
  });

  it("sets lighter scrim defaults for light mode", () => {
    expect(lightTokens["scrim-soft"]).toBe("rgba(0, 0, 0, 0.12)");
    expect(lightTokens["scrim-medium"]).toBe("rgba(0, 0, 0, 0.30)");
    expect(lightTokens["scrim-strong"]).toBe("rgba(0, 0, 0, 0.45)");
  });

  it("sets black-based focus-ring for light mode", () => {
    expect(lightTokens["focus-ring"]).toBe("rgba(0, 0, 0, 0.15)");
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
    expect(bondi.tokens["terminal-white"]).toBe("#8B8C86");
  });

  it("has the correct accent-primary", () => {
    expect(bondi.tokens["accent-primary"]).toBe("#3F9366");
  });

  it("has sandstone cream canvas", () => {
    expect(bondi.tokens["surface-canvas"]).toBe("#F6F0E4");
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
