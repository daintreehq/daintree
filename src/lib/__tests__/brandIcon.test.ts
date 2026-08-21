import { describe, expect, it } from "vitest";
import { contrastRatio } from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";
import { resolveBrandChip } from "../brandIcon";

const CHIP_LIGHT = "#F5F5F5";
const NON_TEXT_CONTRAST_THRESHOLD = 3;

function makeScheme(type: "dark" | "light", surfacePanel: string): AppColorScheme {
  return {
    id: "test",
    name: "Test",
    type,
    builtin: true,
    tokens: { "surface-panel": surfacePanel } as AppColorScheme["tokens"],
  };
}

const DARK = makeScheme("dark", "#1e1e1e");
const LIGHT = makeScheme("light", "#ffffff");

describe("resolveBrandChip", () => {
  it("returns the white tile for a built-in mono mark on dark themes", () => {
    // #000000 (Goose-style silhouette) fails contrast against the dark surface
    // but clears it against the near-white tile — the tile path is preserved.
    const chip = resolveBrandChip("#000000", DARK);
    expect(chip).toEqual({ background: CHIP_LIGHT });
  });

  it("skips the white tile for a user-chosen color on dark themes", () => {
    // Same color, but flagged as a deliberate user choice — render it as-is
    // rather than stamping a white tile that overrides the user's intent.
    const chip = resolveBrandChip("#000000", DARK, true);
    expect(chip).toBeNull();
  });

  it("does not alter colors that already clear contrast on dark themes", () => {
    // A bright color clears 3:1 against the dark surface regardless of provenance.
    expect(resolveBrandChip("#ffffff", DARK, false)).toBeNull();
    expect(resolveBrandChip("#ffffff", DARK, true)).toBeNull();
  });

  it("still applies the light-theme tint correction for user-chosen colors", () => {
    // The light-theme tint path is a helpful readability correction that should
    // remain active even for user choices — only the dark tile is bypassed.
    const lowContrastLight = "#dddddd";
    const chip = resolveBrandChip(lowContrastLight, LIGHT, true);
    expect(chip?.tint).toBeDefined();
    expect(chip?.background).toBeUndefined();
    // The returned tint must actually clear the contrast floor against the surface.
    expect(contrastRatio(chip!.tint!, "#ffffff")).toBeGreaterThanOrEqual(
      NON_TEXT_CONTRAST_THRESHOLD
    );
  });

  it("returns null for an invalid hex regardless of provenance", () => {
    expect(resolveBrandChip("not-a-color", DARK, true)).toBeNull();
    expect(resolveBrandChip(undefined, DARK, true)).toBeNull();
  });
});
