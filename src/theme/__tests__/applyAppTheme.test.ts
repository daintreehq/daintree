// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolveAppTheme } from "@shared/theme";
import { applyAppThemeToRoot } from "../applyAppTheme";

describe("applyAppThemeToRoot", () => {
  it("uses white as the tint for dark themes", () => {
    const root = document.createElement("div");

    applyAppThemeToRoot(root, resolveAppTheme("daintree"));

    expect(root.style.getPropertyValue("--theme-tint")).toBe("#ffffff");
    expect(root.dataset.theme).toBe("daintree");
    expect(root.dataset.colorMode).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("uses the theme foreground ink as the tint for light themes", () => {
    const root = document.createElement("div");
    const bondi = resolveAppTheme("bondi");

    applyAppThemeToRoot(root, bondi);

    expect(root.style.getPropertyValue("--theme-tint")).toBe(bondi.tokens["text-primary"]);
    expect(root.dataset.theme).toBe("bondi");
    expect(root.dataset.colorMode).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });
});
