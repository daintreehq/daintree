import { describe, expect, it } from "vitest";

import {
  ACTION_CATEGORY_LABELS,
  ACTION_CATEGORY_ORDER,
  getActionCategoryLabel,
  humanizeActionCategory,
  orderActionCategories,
} from "../actionCategoryOrder";

describe("orderActionCategories", () => {
  it("returns known categories in the curated order regardless of input order", () => {
    const shuffled = [...ACTION_CATEGORY_ORDER].reverse();
    expect(orderActionCategories(shuffled)).toEqual([...ACTION_CATEGORY_ORDER]);
  });

  it("omits known categories that were not supplied", () => {
    const ordered = orderActionCategories(["git", "worktree"]);
    expect(ordered).toEqual(["worktree", "git"]);
  });

  it("appends unknown categories after every known one", () => {
    const ordered = orderActionCategories(["zzPlugin", "git", "aaPlugin", "worktree"]);
    const firstUnknown = ordered.indexOf("aaPlugin");
    const lastKnown = Math.max(ordered.indexOf("git"), ordered.indexOf("worktree"));
    expect(firstUnknown).toBeGreaterThan(lastKnown);
  });

  it("sorts unknown categories alphabetically, case-insensitively", () => {
    const ordered = orderActionCategories(["Zebra", "apple", "Mango"]);
    expect(ordered).toEqual(["apple", "Mango", "Zebra"]);
  });

  it("drops no category — an unknown one would take its actions off the browse list", () => {
    const input = ["worktree", "somePluginThing", "git", "core", "extra", "test"];
    expect(orderActionCategories(input).slice().sort()).toEqual(input.slice().sort());
  });

  it("collapses duplicate categories to a single group", () => {
    expect(orderActionCategories(["git", "git", "plugin", "plugin"])).toEqual(["git", "plugin"]);
  });

  it("orders a stable result across repeated calls with reshuffled input", () => {
    const a = orderActionCategories(["ui", "custom", "git", "another"]);
    const b = orderActionCategories(["another", "git", "custom", "ui"]);
    expect(a).toEqual(b);
  });
});

describe("humanizeActionCategory", () => {
  it("splits camelCase into sentence case", () => {
    expect(humanizeActionCategory("pluginTools")).toBe("Plugin tools");
  });

  it("treats hyphens and underscores as word breaks", () => {
    expect(humanizeActionCategory("custom-actions")).toBe("Custom actions");
    expect(humanizeActionCategory("custom_actions")).toBe("Custom actions");
  });

  it("capitalizes a single lowercase word", () => {
    expect(humanizeActionCategory("core")).toBe("Core");
  });

  it("falls back to a generic label for a blank category", () => {
    expect(humanizeActionCategory("")).toBe("General");
    expect(humanizeActionCategory("   ")).toBe("General");
  });
});

describe("getActionCategoryLabel", () => {
  it("humanizes categories that have no curated label", () => {
    expect(getActionCategoryLabel("somePlugin")).toBe("Some plugin");
  });

  it("prefers the curated label over the humanized form", () => {
    // At least one curated label must be something the fallback could never
    // produce, or the whole map would be redundant.
    const curated = ACTION_CATEGORY_ORDER.filter(
      (c) => getActionCategoryLabel(c) !== humanizeActionCategory(c)
    );
    expect(curated.length).toBeGreaterThan(0);
    for (const category of curated) {
      expect(getActionCategoryLabel(category)).toBe(ACTION_CATEGORY_LABELS.get(category));
    }
  });

  it("labels every ordered category", () => {
    const unlabelled = ACTION_CATEGORY_ORDER.filter((c) => !ACTION_CATEGORY_LABELS.has(c));
    expect(unlabelled).toEqual([]);
  });

  it("labels no category it does not also order", () => {
    const unordered = [...ACTION_CATEGORY_LABELS.keys()].filter(
      (c) => !ACTION_CATEGORY_ORDER.includes(c)
    );
    expect(unordered).toEqual([]);
  });

  it("survives category names that collide with Object prototype keys", () => {
    // Plugins choose their own category strings. An object-literal lookup would
    // hand back an inherited non-string here, which becomes a section label and
    // throws when React renders it.
    for (const hostile of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(typeof getActionCategoryLabel(hostile)).toBe("string");
    }
  });

  it("gives every ordered category a distinct label so headers are unambiguous", () => {
    const labels = ACTION_CATEGORY_ORDER.map(getActionCategoryLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
