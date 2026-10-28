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

  it("types only declared leaves as setting paths", () => {
    const leaves: SettingPath[] = [
      "remoteHostsPreferences",
      "terminalConfig.fontSize",
      "appState.sidebarWidth",
    ];
    for (const path of leaves) expect(() => settingDeclaration(path), path).not.toThrow();

    const undeclared = () => [
      // @ts-expect-error a split key has no owner of its own
      settingOwner("appState"),
      // @ts-expect-error not a field the catalog declares
      settingOwner("terminalConfig.nope"),
      // @ts-expect-error a whole key has no fields
      settingOwner("projectEnv.anything"),
      // @ts-expect-error not a key the catalog declares
      settingOwner("nope"),
    ];
    expect(undeclared).toThrow(/No setting/);
  });

  it("refuses a split key's bare path, an unknown path, and prototype keys", () => {
    for (const path of [
      "appState",
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
