// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveAppTheme } from "@shared/theme";
import { applyAppThemeToRoot } from "../applyAppTheme";

describe("applyAppThemeToRoot", () => {
  it("uses white as the tint for dark themes", () => {
    const root = document.createElement("div");

    applyAppThemeToRoot(root, resolveAppTheme("daintree"));

    expect(root.style.getPropertyValue("--theme-tint")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--toolbar-project-bg")).not.toBe("");
    expect(root.dataset.theme).toBe("daintree");
    expect(root.dataset.colorMode).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("uses black as the tint for light themes", () => {
    const root = document.createElement("div");
    const bondi = resolveAppTheme("bondi");

    applyAppThemeToRoot(root, bondi);

    expect(root.style.getPropertyValue("--theme-tint")).toBe("#000000");
    expect(root.dataset.theme).toBe("bondi");
    expect(root.dataset.colorMode).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("removes stale component extension vars between themes", () => {
    const root = document.createElement("div");
    applyAppThemeToRoot(root, {
      ...resolveAppTheme("daintree"),
      extensions: { "custom-foo": "#123456" },
    });
    expect(root.style.getPropertyValue("--custom-foo")).toBe("#123456");

    applyAppThemeToRoot(root, resolveAppTheme("bondi"));

    expect(root.style.getPropertyValue("--custom-foo")).toBe("");
  });
});
