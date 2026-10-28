import { describe, expect, it } from "vitest";
import {
  appCustomSchemesReadSchema,
  appCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../customSchemes.js";

function storedScheme(extensions: Record<string, string>) {
  return {
    id: "custom-mine",
    name: "Mine",
    type: "dark",
    builtin: false,
    tokens: { "text-primary": "#e6e6e6" },
    extensions,
  };
}

describe("custom app scheme extensions", () => {
  it("strips unregistered extension keys on write without rejecting the scheme", () => {
    const result = appCustomSchemesWriteSchema.safeParse([
      storedScheme({ "theme-text-primary": "#202020", "panel-grid-bg": "#101010" }),
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0]?.extensions).toEqual({ "panel-grid-bg": "#101010" });
  });

  it("keeps a stored theme that carries a shadowing key, minus that key", () => {
    const result = migrateCustomSchemes(
      [storedScheme({ "theme-color-mode": "light", "shadow-modal": "none" })],
      appCustomSchemesReadSchema,
      appCustomSchemesWriteSchema
    );

    expect(result.droppedCount).toBe(0);
    expect(result.schemes.map((scheme) => scheme.id)).toEqual(["custom-mine"]);
    expect(result.schemes[0]?.extensions).toEqual({});
  });
});
