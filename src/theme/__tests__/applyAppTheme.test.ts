// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { APP_THEME_TOKEN_KEYS, type AppColorScheme } from "@shared/theme";
import { applyAppThemeToRoot } from "../applyAppTheme";

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
