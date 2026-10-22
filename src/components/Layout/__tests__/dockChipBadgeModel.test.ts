import { describe, expect, it } from "vitest";
import type { PluginPanelBadge, PluginPanelBadgeColor } from "@shared/types/plugin";
import { dockChipBadgeLabelSuffix, foldDockChipBadges } from "../dockChipBadgeModel";

const name = (id: string) => `Name of ${id}`;
const label = (text: string, color?: PluginPanelBadgeColor): PluginPanelBadge => ({
  kind: "label",
  text,
  color,
});
const dot = (color?: PluginPanelBadgeColor): PluginPanelBadge => ({ kind: "dot", color });

describe("foldDockChipBadges", () => {
  it("returns null with no badges", () => {
    expect(foldDockChipBadges([], "p", name)).toBeNull();
  });

  it("shows a single numeric label as a count and caps it at 9+", () => {
    expect(foldDockChipBadges([["p", label("3")]], "p", name)).toMatchObject({
      countGlyph: "3",
      description: "3",
    });
    expect(foldDockChipBadges([["p", label("12")]], "p", name)?.countGlyph).toBe("9+");
  });

  it("falls back to a dot for a non-numeric label and keeps its full text", () => {
    expect(foldDockChipBadges([["p", label("3 new")]], "p", name)).toMatchObject({
      countGlyph: null,
      description: "3 new",
    });
  });

  it("describes an unexplained dot by its colour", () => {
    expect(foldDockChipBadges([["p", dot("error")]], "p", name)).toMatchObject({
      countGlyph: null,
      color: "error",
      description: "error",
    });
  });

  it("folds several badges into one dot with every description, in plugin-id order", () => {
    const model = foldDockChipBadges(
      [
        ["b", label("2", "warning")],
        ["a", label("5")],
      ],
      "a",
      name
    );
    expect(model).toMatchObject({
      countGlyph: null,
      color: "default",
      description: "5; Name of b: 2",
    });
  });

  it("draws a foreign badge neutral and names its plugin", () => {
    expect(foldDockChipBadges([["x", label("1", "error")]], "p", name)).toMatchObject({
      color: "default",
      description: "Name of x: 1",
    });
  });

  it("does not let a foreign error outrank an owner's neutral badge", () => {
    const model = foldDockChipBadges(
      [
        ["p", label("1")],
        ["x", dot("error")],
      ],
      "p",
      name
    );
    expect(model?.color).toBe("default");
  });

  it("keeps an owner's warning above a foreign error", () => {
    const model = foldDockChipBadges(
      [
        ["p", dot("warning")],
        ["x", dot("error")],
      ],
      "p",
      name
    );
    expect(model?.color).toBe("warning");
  });

  it("treats every badge as foreign when the panel has no owner", () => {
    expect(foldDockChipBadges([["x", dot("error")]], null, name)?.color).toBe("default");
  });
});

describe("dockChipBadgeLabelSuffix", () => {
  it("is empty without a badge and appends the description with one", () => {
    expect(dockChipBadgeLabelSuffix(null)).toBe("");
    expect(
      dockChipBadgeLabelSuffix({ countGlyph: null, color: "default", description: "3 new" })
    ).toBe(" — 3 new");
  });
});
