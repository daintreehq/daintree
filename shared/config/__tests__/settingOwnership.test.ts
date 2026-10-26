import { describe, expect, it } from "vitest";
import {
  SETTING_CATALOG,
  settingDeclaration,
  settingOwner,
  type SettingPath,
} from "../settingOwnership.js";

const entries: Readonly<Record<string, object>> = SETTING_CATALOG.config.entries;

function declaredLeaves(): [string, unknown][] {
  return Object.entries(entries).flatMap(([key, entry]) =>
    "fields" in entry
      ? Object.entries(entry.fields as Record<string, unknown>).map(
          ([field, leaf]): [string, unknown] => [`${key}.${field}`, leaf]
        )
      : [[key, entry]]
  );
}

describe("settings catalog lookup", () => {
  it("resolves every declared leaf of the settings file to its own declaration", () => {
    const leaves = declaredLeaves();
    expect(leaves.length).toBeGreaterThan(Object.keys(entries).length);
    for (const [path, leaf] of leaves) {
      expect(settingDeclaration(path as SettingPath), path).toBe(leaf);
      expect(settingOwner(path as SettingPath), path).toBe((leaf as { owner: string }).owner);
    }
  });

  it("refuses a split key's bare path, an unknown path, and prototype keys", () => {
    for (const path of [
      "notificationSettings",
      "terminalConfig",
      "terminalConfig.nope",
      "nope",
      "projectEnv.anything",
      "terminalConfig.fontSize.extra",
      "__proto__",
      "toString",
      "terminalConfig.constructor",
      "",
    ]) {
      expect(() => settingDeclaration(path as SettingPath), path).toThrow(/No setting/);
    }
  });
});
