// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_THEME_TOKEN_KEYS,
  DIFF_TEXT_MIN_CONTRAST,
  STATUS_TEXT_CONTRAST,
  STATUS_TEXT_INKS,
  contrastRatio,
  getAppThemeById,
  getAppThemeCssVariables,
  hexToOklch,
  normalizeAppColorScheme,
  resolveDiffTextBackdrops,
  resolveStatusTextBackdrops,
  type AppColorScheme,
} from "@shared/theme";
import { BLUE_YELLOW_OVERRIDES, RED_GREEN_OVERRIDES } from "@shared/theme/colorVisionOverrides";
import { applyAppThemeToRoot, applyColorVisionMode, applyDefaultAppTheme } from "../applyAppTheme";

const DIFF_TOKENS = [
  "--theme-diff-insert-background",
  "--theme-diff-insert-edit-background",
  "--theme-diff-gutter-insert",
  "--theme-diff-delete-background",
  "--theme-diff-delete-edit-background",
  "--theme-diff-gutter-delete",
  "--theme-diff-text-insert",
  "--theme-diff-text-delete",
] as const;

function createTestScheme(
  id: string,
  type: "dark" | "light",
  extensions: Record<string, string> = {}
): AppColorScheme {
  const tokens = Object.fromEntries(
    APP_THEME_TOKEN_KEYS.map((key) => [key, "#101010"])
  ) as AppColorScheme["tokens"];
  tokens.tint = type === "dark" ? "#ffffff" : "#000000";

  return {
    id,
    name: id,
    type,
    builtin: false,
    tokens,
    extensions,
  };
}

describe("applyAppThemeToRoot", () => {
  it("applies derived root metadata for dark themes", () => {
    const root = document.createElement("div");

    applyAppThemeToRoot(
      root,
      createTestScheme("test-dark", "dark", {
        "toolbar-project-bg": "linear-gradient(#111111, #222222)",
      })
    );

    expect(root.style.getPropertyValue("--theme-tint")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--toolbar-project-bg")).toBe(
      "linear-gradient(#111111, #222222)"
    );
    expect(root.dataset.theme).toBe("test-dark");
    expect(root.dataset.colorMode).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("removes stale component extension vars between themes", () => {
    const root = document.createElement("div");

    applyAppThemeToRoot(
      root,
      createTestScheme("with-extension", "dark", { "panel-grid-bg": "#123456" })
    );
    expect(root.style.getPropertyValue("--panel-grid-bg")).toBe("#123456");

    applyAppThemeToRoot(root, createTestScheme("without-extension", "light"));

    expect(root.style.getPropertyValue("--panel-grid-bg")).toBe("");
  });

  it("carries the light chrome on light and hands it back to the stylesheet on dark", () => {
    const root = document.createElement("div");
    const lightOnly = ["--shadow-overlay", "--shadow-modal", "--pill-surface"];

    applyAppThemeToRoot(root, createTestScheme("test-light", "light"));
    expect(root.style.getPropertyValue("--theme-surface-dialog")).toContain(
      "--theme-surface-panel-elevated"
    );
    expect(root.style.getPropertyValue("--shadow-modal")).toContain("--theme-shadow-dialog");

    applyAppThemeToRoot(root, createTestScheme("test-dark", "dark"));
    expect(root.style.getPropertyValue("--theme-surface-dialog")).toBe(
      "var(--theme-surface-panel)"
    );
    // The dark shadow and pill stacks are the stylesheet's :root defaults.
    for (const name of lightOnly) expect(root.style.getPropertyValue(name)).toBe("");
  });

  it("keeps the light chrome when a theme's extension names it", () => {
    // `shadow-modal` is not a registered extension key, so it is an engine
    // variable a theme cannot replace (#13761).
    const root = document.createElement("div");
    applyAppThemeToRoot(root, createTestScheme("test-light", "light", { "shadow-modal": "none" }));
    expect(root.style.getPropertyValue("--shadow-modal")).toContain("--theme-shadow-dialog");
  });

  it("drops a stale unregistered variable once a sanitized theme is applied", () => {
    const root = document.createElement("div");
    root.style.setProperty("--custom-foo", "#123456");
    root.dataset.themeVariableKeys = "--custom-foo";

    applyAppThemeToRoot(root, createTestScheme("test-dark", "dark", { "custom-foo": "#123456" }));

    expect(root.style.getPropertyValue("--custom-foo")).toBe("");
  });
});

import { WORKTREE_COLOR_PALETTE } from "@shared/theme/worktreeColors";

const CATEGORY_TOKENS = WORKTREE_COLOR_PALETTE.map((token) => `--theme-${token}`);

describe("applyColorVisionMode", () => {
  it("switches from red-green to blue-yellow mode", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "red-green");
    applyColorVisionMode(root, "blue-yellow");

    expect(root.dataset.colorblind).toBe("blue-yellow");
  });

  it("clears all overrides on default mode", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "red-green");
    applyColorVisionMode(root, "default");

    for (const token of CATEGORY_TOKENS) {
      expect(root.style.getPropertyValue(token)).toBe("");
    }
    expect(root.style.getPropertyValue("--theme-status-success")).toBe("");
    expect(root.dataset.colorblind).toBeUndefined();
  });

  it("switches from blue-yellow to red-green clearing blue-yellow-only tokens", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "blue-yellow");
    applyColorVisionMode(root, "red-green");

    expect(root.style.getPropertyValue("--theme-status-info")).toBe("");
    expect(root.dataset.colorblind).toBe("red-green");
  });
});

describe("applyColorVisionMode diff token restoration", () => {
  // Regression: the --theme-diff-* tokens (consumed by .light .diff-viewer) and
  // --theme-status-* have no stylesheet fallback. A mode that doesn't override
  // them must restore their base values, not strip them to undefined, when the
  // active scheme is supplied. Use a real built-in light scheme so
  // getAppThemeCssVariables produces the genuine derived diff/status values.
  const lightScheme = getAppThemeById("bondi")!;
  const base = getAppThemeCssVariables(lightScheme);

  it("red-green overrides the diff gutters to the CVD palette", () => {
    const root = document.createElement("div");
    applyAppThemeToRoot(root, lightScheme);
    applyColorVisionMode(root, "red-green", lightScheme);

    expect(root.style.getPropertyValue("--theme-diff-gutter-insert")).toBe(
      RED_GREEN_OVERRIDES["--theme-diff-gutter-insert"]
    );
    expect(root.style.getPropertyValue("--theme-diff-gutter-delete")).toBe(
      RED_GREEN_OVERRIDES["--theme-diff-gutter-delete"]
    );
    // Differs from the base scheme — the override actually took effect.
    expect(root.style.getPropertyValue("--theme-diff-gutter-insert")).not.toBe(
      base["--theme-diff-gutter-insert"]
    );
  });

  it("red-green lifts the churn inks from the CVD status inks against this theme's backdrops", () => {
    const root = document.createElement("div");
    applyAppThemeToRoot(root, lightScheme);
    applyColorVisionMode(root, "red-green", lightScheme);

    const backdrops = resolveDiffTextBackdrops(lightScheme.tokens);
    for (const [token, status] of [
      ["--theme-diff-text-insert", "--theme-status-success"],
      ["--theme-diff-text-delete", "--theme-status-danger"],
    ] as const) {
      const ink = root.style.getPropertyValue(token);
      expect(ink).not.toBe(base[token]);
      const cvdHue = hexToOklch(RED_GREEN_OVERRIDES[status]!)!.h;
      expect(Math.abs(hexToOklch(ink)!.h - cvdHue)).toBeLessThan(1.5);
      for (const backdrop of backdrops) {
        expect(
          contrastRatio(ink, backdrop.hex),
          `${token} on ${backdrop.label}`
        ).toBeGreaterThanOrEqual(DIFF_TEXT_MIN_CONTRAST);
      }
    }

    applyColorVisionMode(root, "default", lightScheme);
    expect(root.style.getPropertyValue("--theme-diff-text-insert")).toBe(
      base["--theme-diff-text-insert"]
    );
  });

  it("lifts the red-green churn inks against a dark theme's own backdrops", () => {
    const darkScheme = getAppThemeById("daintree")!;
    const root = document.createElement("div");
    applyAppThemeToRoot(root, darkScheme);
    applyColorVisionMode(root, "red-green", darkScheme);
    const darkInk = root.style.getPropertyValue("--theme-diff-text-insert");

    for (const backdrop of resolveDiffTextBackdrops(darkScheme.tokens)) {
      expect(contrastRatio(darkInk, backdrop.hex), backdrop.label).toBeGreaterThanOrEqual(
        DIFF_TEXT_MIN_CONTRAST
      );
    }
    // Lighter than the raw override on dark; Bondi lifts the same hue darker.
    expect(hexToOklch(darkInk)!.l).toBeGreaterThan(
      hexToOklch(RED_GREEN_OVERRIDES["--theme-status-success"]!)!.l
    );
  });

  it("only replaces a churn ink whose status ink the mode overrides", () => {
    const named = normalizeAppColorScheme({
      id: "named-churn",
      name: "Named churn",
      type: "dark",
      tokens: { "diff-text-insert": "#eeeeee", "diff-text-delete": "#dddddd" },
    });
    const root = document.createElement("div");
    applyAppThemeToRoot(root, named);

    applyColorVisionMode(root, "blue-yellow", named);
    expect(root.style.getPropertyValue("--theme-diff-text-insert")).toBe("#eeeeee");
    expect(root.style.getPropertyValue("--theme-diff-text-delete")).toBe("#dddddd");

    applyColorVisionMode(root, "red-green", named);
    expect(root.style.getPropertyValue("--theme-diff-text-insert")).not.toBe("#eeeeee");
  });

  it("blue-yellow restores base diff and status tokens instead of stripping them", () => {
    const root = document.createElement("div");
    applyAppThemeToRoot(root, lightScheme);
    applyColorVisionMode(root, "blue-yellow", lightScheme);

    for (const token of DIFF_TOKENS) {
      expect(root.style.getPropertyValue(token), `${token} should keep its base value`).toBe(
        base[token]
      );
    }
    expect(root.style.getPropertyValue("--theme-status-success")).toBe(
      base["--theme-status-success"]
    );
    expect(root.style.getPropertyValue("--theme-status-danger")).toBe(
      base["--theme-status-danger"]
    );
  });

  it("switching red-green to blue-yellow restores diff tokens to base", () => {
    const root = document.createElement("div");
    applyAppThemeToRoot(root, lightScheme);
    applyColorVisionMode(root, "red-green", lightScheme);
    applyColorVisionMode(root, "blue-yellow", lightScheme);

    for (const token of DIFF_TOKENS) {
      expect(root.style.getPropertyValue(token)).toBe(base[token]);
    }
  });

  it("switching red-green to default restores diff tokens to base", () => {
    const root = document.createElement("div");
    applyAppThemeToRoot(root, lightScheme);
    applyColorVisionMode(root, "red-green", lightScheme);
    applyColorVisionMode(root, "default", lightScheme);

    for (const token of DIFF_TOKENS) {
      expect(root.style.getPropertyValue(token)).toBe(base[token]);
    }
    expect(root.dataset.colorblind).toBeUndefined();
  });
});

describe("applyDefaultAppTheme (#9169)", () => {
  function mockPrefersDark(prefersDark: boolean): void {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("dark") ? prefersDark : !prefersDark,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
  }

  afterEach(() => {
    delete window.__DAINTREE_INITIAL_THEME__;
    vi.unstubAllGlobals();
  });

  it("applies the seeded persisted scheme over the prefers-color-scheme default", () => {
    // OS prefers dark (would resolve to daintree) but the persisted scheme is bondi.
    mockPrefersDark(true);
    window.__DAINTREE_INITIAL_THEME__ = { colorSchemeId: "bondi" };
    const root = document.createElement("div");

    const applied = applyDefaultAppTheme(root);

    expect(applied.id).toBe("bondi");
    expect(root.dataset.theme).toBe("bondi");
  });

  it("falls back to prefers-color-scheme when the seeded id is unknown (e.g. a custom scheme)", () => {
    // Unknown ids must not paint a wrong built-in theme — they defer to the
    // async useAppThemeConfig phase. OS prefers light → bondi.
    mockPrefersDark(false);
    window.__DAINTREE_INITIAL_THEME__ = { colorSchemeId: "totally-unknown-scheme" };
    const root = document.createElement("div");

    const applied = applyDefaultAppTheme(root);

    expect(applied.id).toBe("bondi");
    expect(root.dataset.theme).toBe("bondi");
  });

  it("falls back to prefers-color-scheme (dark) when no scheme is seeded", () => {
    mockPrefersDark(true);
    const root = document.createElement("div");

    const applied = applyDefaultAppTheme(root);

    expect(applied.id).toBe("daintree");
    expect(root.dataset.theme).toBe("daintree");
  });

  it("falls back to prefers-color-scheme when the seeded id is an empty string", () => {
    mockPrefersDark(true);
    window.__DAINTREE_INITIAL_THEME__ = { colorSchemeId: "" };
    const root = document.createElement("div");

    const applied = applyDefaultAppTheme(root);

    expect(applied.id).toBe("daintree");
    expect(root.dataset.theme).toBe("daintree");
  });
});

describe("applyColorVisionMode status text inks", () => {
  // A git status letter paints the text-grade twin of its status hue, lifted
  // against the theme's own backdrops, so a mode that swaps the hue has to lift
  // it again or the letter keeps the very red or green the mode replaces.
  it.each([
    ["red-green", RED_GREEN_OVERRIDES, "daintree"],
    ["red-green", RED_GREEN_OVERRIDES, "bondi"],
    ["blue-yellow", BLUE_YELLOW_OVERRIDES, "highlands"],
    ["blue-yellow", BLUE_YELLOW_OVERRIDES, "hokkaido"],
  ] as const)("%s lifts the letters it recolours on %s", (mode, overrides, id) => {
    const scheme = getAppThemeById(id)!;
    const root = document.createElement("div");
    applyAppThemeToRoot(root, scheme);
    applyColorVisionMode(root, mode, scheme);

    const recoloured = Object.entries(STATUS_TEXT_INKS).filter(([status, text]) => {
      const hue = overrides[`--theme-${status}`];
      const ink = root.style.getPropertyValue(`--theme-${text}`);
      if (!hue) {
        expect(ink, text).toBe(scheme.tokens[text]);
        return false;
      }
      expect(ink, text).not.toBe(scheme.tokens[text]);
      for (const backdrop of resolveStatusTextBackdrops(hue, scheme.tokens)) {
        expect(contrastRatio(ink, backdrop.hex), `${text} on ${backdrop.label}`).toBeGreaterThanOrEqual(
          STATUS_TEXT_CONTRAST.minimum
        );
      }
      return true;
    });
    expect(recoloured).toHaveLength(2);
  });

  it("returning to default restores the theme's own inks", () => {
    const scheme = getAppThemeById("bondi")!;
    const root = document.createElement("div");
    applyAppThemeToRoot(root, scheme);
    applyColorVisionMode(root, "red-green", scheme);
    applyColorVisionMode(root, "blue-yellow", scheme);
    applyColorVisionMode(root, "default", scheme);

    for (const text of Object.values(STATUS_TEXT_INKS)) {
      expect(root.style.getPropertyValue(`--theme-${text}`), text).toBe(scheme.tokens[text]);
    }
  });
});
