import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_CATEGORY_ORDER,
  isReservedActionCategory,
  normalizePluginActionCategory,
} from "../actionCategories.js";

describe("normalizePluginActionCategory", () => {
  it("applies NFC, drops control characters and trims", () => {
    expect(normalizePluginActionCategory("  Café\u0007\n ")).toBe("Café");
  });
});

describe("isReservedActionCategory", () => {
  it("matches built-in ids case-insensitively", () => {
    expect(isReservedActionCategory("worktree")).toBe(true);
    expect(isReservedActionCategory("DevServer")).toBe(true);
    expect(isReservedActionCategory("Linear Planner")).toBe(false);
  });

  it("reserves every category a built-in action definition declares", () => {
    const dir = path.resolve(__dirname, "../../../src/services/actions/definitions");
    const used = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      for (const m of readFileSync(path.join(dir, file), "utf8").matchAll(
        /^\s+category: "([A-Za-z]+)"/gm
      )) {
        used.add(m[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((c) => !isReservedActionCategory(c))).toEqual([]);
  });

  it("reserves the whole browse order", () => {
    expect(ACTION_CATEGORY_ORDER.filter((c) => !isReservedActionCategory(c))).toEqual([]);
  });
});
