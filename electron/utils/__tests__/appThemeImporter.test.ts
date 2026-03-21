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

  it("preserves location and heroImage metadata through import", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Ecosystem Theme",
        type: "dark",
        location: "Daintree Rainforest, Queensland, Australia",
        heroImage: "/themes/daintree.webp",
        heroVideo: "/themes/daintree.webm",
        tokens: {
          "surface-canvas": "#19191a",
          "accent-primary": "#3E9066",
        },
      }),
      "ecosystem.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.location).toBe("Daintree Rainforest, Queensland, Australia");
    expect(result.scheme.heroImage).toBe("/themes/daintree.webp");
    expect(result.scheme.heroVideo).toBe("/themes/daintree.webm");
  });

  it("omits metadata fields when not provided", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Plain Theme",
        type: "dark",
        tokens: {
          "surface-canvas": "#101010",
          "accent-primary": "#ff0000",
        },
      }),
      "plain.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.location).toBeUndefined();
    expect(result.scheme.heroImage).toBeUndefined();
    expect(result.scheme.heroVideo).toBeUndefined();
  });

  it("does not treat metadata keys as unknown tokens in flat format", () => {
    const result = parseAppThemeContent(
      JSON.stringify({
        name: "Flat with metadata",
        type: "dark",
        location: "Test Location",
        heroImage: "/test.webp",
        "surface-canvas": "#101010",
        "accent-primary": "#ff0000",
      }),
      "flat-meta.json"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheme.location).toBe("Test Location");
    expect(result.warnings.every((w) => !w.message.includes("location"))).toBe(true);
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
