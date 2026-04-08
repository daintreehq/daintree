import { describe, expect, it } from "vitest";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

describe("built-in themes", () => {
  it.each(BUILT_IN_THEME_SOURCES.map((t) => [t.id, t]))("%s has materialBlur set", (_id, theme) => {
    expect(theme.palette.strategy?.materialBlur).toBeGreaterThan(0);
    expect(theme.palette.strategy?.materialSaturation).toBeGreaterThan(0);
  });

  it.each(
    BUILT_IN_THEME_SOURCES.filter((t) => ["svalbard", "hokkaido"].includes(t.id)).map((t) => [
      t.id,
      t,
    ])
  )("%s overlay/border rgba tokens use correct overlayTint RGB", (_id, theme) => {
    const tint = theme.palette.overlayTint;
    if (!tint) return;
    const [r, g, b] = hexToRgb(tint);
    const tintPattern = `${r},${g},${b}`;
    const overlayKeys = Object.entries(theme.tokens ?? {}).filter(([k]) =>
      /^(overlay|border|scrim|surface-(hover|active))/.test(k)
    );
    for (const [key, val] of overlayKeys) {
      if (typeof val !== "string") continue;
      const m = val.match(/rgba\((\d+),(\d+),(\d+),/);
      if (!m) continue;
      const found = `${m[1]},${m[2]},${m[3]}`;
      expect(found, `${key} rgba should use overlayTint ${tintPattern}`).toBe(tintPattern);
    }
  });

  it.each(
    BUILT_IN_THEME_SOURCES.filter((t) => ["svalbard", "hokkaido"].includes(t.id)).map((t) => [
      t.id,
      t,
    ])
  )("%s elevated surface matches extension tokens", (_id, theme) => {
    const elevated = theme.palette.surfaces.elevated;
    const elevatedRefs = ["pulse-card-bg", "pulse-ring-offset", "sidebar-active-bg"];
    for (const key of elevatedRefs) {
      const val = theme.extensions?.[key];
      if (val) expect(val, `${key} should match elevated surface`).toBe(elevated);
    }
  });

  it.each(BUILT_IN_THEME_SOURCES.map((t) => [t.id, t]))(
    "%s accent RGB matches focus-ring token",
    (_id, theme) => {
      const accent = theme.palette.accent;
      const [r, g, b] = hexToRgb(accent);
      const focusRing = theme.tokens?.["focus-ring"];
      if (!focusRing || typeof focusRing !== "string") return;
      const m = focusRing.match(/rgba\((\d+),(\d+),(\d+),/);
      if (!m) return;
      expect([parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]).toEqual([r, g, b]);
    }
  );
});
