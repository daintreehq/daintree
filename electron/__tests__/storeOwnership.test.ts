import { describe, expect, it } from "vitest";
import {
  APP_STATE_FIELD_OWNERSHIP,
  NOTIFICATION_SETTINGS_FIELD_OWNERSHIP,
  STORE_KEY_OWNERSHIP,
  TERMINAL_CONFIG_FIELD_OWNERSHIP,
} from "../storeOwnership.js";
import { SETTING_CATALOG } from "../../shared/config/settingOwnership.js";

const FIELD_TABLES: Record<string, Readonly<Record<string, string>>> = {
  terminalConfig: TERMINAL_CONFIG_FIELD_OWNERSHIP,
  appState: APP_STATE_FIELD_OWNERSHIP,
  notificationSettings: NOTIFICATION_SETTINGS_FIELD_OWNERSHIP,
};

describe("store ownership derived from the settings catalog", () => {
  it("names a key split exactly when its fields hold both owners", () => {
    for (const [key, fields] of Object.entries(FIELD_TABLES)) {
      const owners = new Set(Object.values(fields));
      const expected = owners.size > 1 ? "split" : [...owners][0];
      expect(STORE_KEY_OWNERSHIP[key as keyof typeof STORE_KEY_OWNERSHIP], key).toBe(expected);
    }
  });

  it("gives main a field table for every key the catalog splits", () => {
    const split = Object.entries(SETTING_CATALOG.config.entries)
      .filter(([, entry]) => "fields" in entry)
      .map(([key]) => key);
    expect(split.sort()).toEqual(Object.keys(FIELD_TABLES).sort());
  });

  it("routes each field by the owner the catalog declares for it", () => {
    for (const [key, fields] of Object.entries(FIELD_TABLES)) {
      const entry =
        SETTING_CATALOG.config.entries[key as keyof typeof SETTING_CATALOG.config.entries];
      const declared = "fields" in entry ? entry.fields : {};
      expect(Object.keys(fields).sort(), key).toEqual(Object.keys(declared).sort());
      for (const [field, owner] of Object.entries(fields)) {
        expect(owner, `${key}.${field}`).toBe(
          (declared as Record<string, { owner: string }>)[field]?.owner
        );
      }
    }
  });
});
