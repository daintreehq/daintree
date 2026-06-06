// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_THEME_TOKEN_KEYS,
  getAppThemeById,
  getAppThemeCssVariables,
  type AppColorScheme,
} from "@shared/theme";
import { RED_GREEN_OVERRIDES } from "@shared/theme/colorVisionOverrides";
import {
  ALL_CVD_TOKENS,
  applyAppThemeToRoot,
  applyColorVisionMode,
  applyDefaultAppTheme,
} from "../applyAppTheme";

const DIFF_TOKENS = [
  "--theme-diff-insert-background",
  "--theme-diff-insert-edit-background",
  "--theme-diff-gutter-insert",
  "--theme-diff-delete-background",
  "--theme-diff-delete-edit-background",
  "--theme-diff-gutter-delete",
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

  it("applies derived root metadata for light themes", () => {
    const root = document.createElement("div");

    applyAppThemeToRoot(root, createTestScheme("test-light", "light"));

    expect(root.style.getPropertyValue("--theme-tint")).toBe("#000000");
    expect(root.dataset.theme).toBe("test-light");
    expect(root.dataset.colorMode).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("removes stale component extension vars between themes", () => {
    const root = document.createElement("div");

    applyAppThemeToRoot(
      root,
      createTestScheme("with-extension", "dark", { "custom-foo": "#123456" })
    );
    expect(root.style.getPropertyValue("--custom-foo")).toBe("#123456");

    applyAppThemeToRoot(root, createTestScheme("without-extension", "light"));

    expect(root.style.getPropertyValue("--custom-foo")).toBe("");
  });
});

import { WORKTREE_COLOR_PALETTE } from "@shared/theme/worktreeColors";

const CATEGORY_TOKENS = WORKTREE_COLOR_PALETTE.map((token) => `--theme-${token}`);

describe("applyColorVisionMode", () => {
  it("sets the colorblind dataset flag in red-green mode", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "red-green");

    expect(root.dataset.colorblind).toBe("red-green");
  });

  it("sets the colorblind dataset flag in blue-yellow mode", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "blue-yellow");

    expect(root.dataset.colorblind).toBe("blue-yellow");
  });

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

  it("does not set status-info in red-green mode", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "red-green");

    expect(root.style.getPropertyValue("--theme-status-info")).toBe("");
  });

  it("ALL_CVD_TOKENS covers the expected token count", () => {
    // Canary: if someone adds or removes tokens from either map,
    // this size changes and the test catches it for review.
    // 39 red-green (incl. 2 status surfaces + 6 diff tokens) + 28 blue-yellow
    // (incl. 2 status surfaces) = 67 total, 49 unique after dedup
    expect(ALL_CVD_TOKENS.size).toBe(49);
  });

  it("switches from blue-yellow to red-green clearing blue-yellow-only tokens", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "blue-yellow");
    applyColorVisionMode(root, "red-green");

    expect(root.style.getPropertyValue("--theme-status-info")).toBe("");
    expect(root.dataset.colorblind).toBe("red-green");
  });

  it("switches from red-green to default clearing syntax tokens", () => {
    const root = document.createElement("div");
    applyColorVisionMode(root, "red-green");
    applyColorVisionMode(root, "default");

    expect(root.style.getPropertyValue("--theme-syntax-comment")).toBe("");
    expect(root.style.getPropertyValue("--theme-syntax-keyword")).toBe("");
    expect(root.style.getPropertyValue("--theme-syntax-string")).toBe("");
    expect(root.style.getPropertyValue("--theme-category-blue")).toBe("");
    expect(root.dataset.colorblind).toBeUndefined();
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

  it("seeds a non-default built-in scheme that exists in the registry", () => {
    mockPrefersDark(true);
    // Sanity: the seeded id resolves to a real built-in scheme object.
    expect(getAppThemeById("table-mountain")).toBeDefined();
    window.__DAINTREE_INITIAL_THEME__ = { colorSchemeId: "table-mountain" };
    const root = document.createElement("div");

    const applied = applyDefaultAppTheme(root);

    expect(applied.id).toBe("table-mountain");
    expect(root.dataset.theme).toBe("table-mountain");
  });
});
