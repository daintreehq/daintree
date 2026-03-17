import { describe, expect, it } from "vitest";
import { parseAppThemeContent } from "../appThemeImporter.js";

describe("appThemeImporter", () => {
  it("parses nested partial light themes against the light fallback base", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Partial Light",
        type: "light",
        tokens: {
          "surface-canvas": "#ffffff",
          "accent-primary": "#2f855a",
        },
      }),
      "partial-light.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.type).toBe("light");
    expect(result.scheme.tokens["surface-canvas"]).toBe("#ffffff");
    expect(result.scheme.tokens["surface-panel"]).toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  it("infers theme type from surface-canvas when missing and warns", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Inferred Light",
        tokens: {
          "surface-canvas": "#faf7f2",
        },
      }),
      "inferred-light.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.type).toBe("light");
    expect(result.warnings.some((warning) => warning.message.includes('Add "type"'))).toBe(true);
  });

  it("warns about unknown nested tokens but still imports the scheme", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Unknown Token Theme",
        type: "dark",
        tokens: {
          "surface-canvas": "#101010",
          "not-a-real-token": "#ffffff",
        },
      }),
      "unknown-token-theme.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.warnings.some((warning) => warning.message.includes("Ignored unknown tokens"))
    ).toBe(true);
  });

  it("rejects JSON without recognizable app theme tokens", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Bad Theme",
        type: "dark",
        foo: "bar",
      }),
      "bad-theme.json"
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("No recognized app theme tokens");
  });
});
