import { describe, expect, it } from "vitest";
import {
  APP_STATE_FIELD_OWNERSHIP,
  AUDIT_LOGS_STORE_OWNERSHIP,
  DECISIONS_FIELD_OWNERSHIP,
  STORE_KEY_OWNERSHIP,
  TERMINAL_CONFIG_FIELD_OWNERSHIP,
  WINDOW_STATES_STORE_OWNERSHIP,
} from "../storeOwnership.js";
import { SETTING_CATALOG } from "../../shared/config/settingOwnership.js";
import { mergeByOwnership, splitByOwnership } from "../remote/hybrid/fieldOwnership.js";
import { defaultDecisionsSettings } from "../services/decisions/decisionsSettings.js";
import type { DecisionsSettings } from "../../shared/types/decisions.js";

type Declarations = Readonly<Record<string, { readonly owner: string }>>;

function declaredOwners(declarations: Declarations): Record<string, string> {
  return Object.fromEntries(Object.entries(declarations).map(([key, d]) => [key, d.owner]));
}

const config: Readonly<
  Record<string, { readonly owner: string } | { readonly fields: Declarations }>
> = SETTING_CATALOG.config.entries;

const FIELD_TABLES: Record<string, Readonly<Record<string, string>>> = {
  terminalConfig: TERMINAL_CONFIG_FIELD_OWNERSHIP,
  appState: APP_STATE_FIELD_OWNERSHIP,
  decisions: DECISIONS_FIELD_OWNERSHIP,
};

describe("store ownership derived from the settings catalog", () => {
  it("names every key by its declared owner, or split exactly when its fields hold both", () => {
    expect(Object.keys(STORE_KEY_OWNERSHIP)).toEqual(Object.keys(config));
    for (const [key, entry] of Object.entries(config)) {
      const owners = new Set(
        "fields" in entry ? Object.values(declaredOwners(entry.fields)) : [entry.owner]
      );
      const expected = owners.size > 1 ? "split" : [...owners][0];
      expect(STORE_KEY_OWNERSHIP[key as keyof typeof STORE_KEY_OWNERSHIP], key).toBe(expected);
    }
  });

  it("gives main a field table for every key the catalog splits", () => {
    const split = Object.entries(config)
      .filter(([, entry]) => "fields" in entry)
      .map(([key]) => key);
    expect(split.sort()).toEqual(Object.keys(FIELD_TABLES).sort());
  });

  it("routes each field by the owner the catalog declares for it", () => {
    for (const [key, table] of Object.entries(FIELD_TABLES)) {
      const entry = config[key];
      expect(entry && "fields" in entry, key).toBe(true);
      if (entry && "fields" in entry) expect(table, key).toEqual(declaredOwners(entry.fields));
    }
  });

  it("routes every Decisions field, the switch and relay included, to this machine and never a host", () => {
    const fields = Object.keys(defaultDecisionsSettings()) as (keyof DecisionsSettings)[];
    expect(Object.keys(DECISIONS_FIELD_OWNERSHIP).sort()).toEqual([...fields].sort());

    const owners: DecisionsSettings = {
      enabled: true,
      relayOrigin: "https://relay.owner.example",
      installationId: "owner-installation",
      deviceId: "owner-desktop-01",
      hostId: "owner-host-0001",
      proxyAllowlisted: true,
    };
    const hostCopy: DecisionsSettings = {
      enabled: false,
      relayOrigin: "https://relay.host.example",
      installationId: "host-installation",
      deviceId: "host-device-0001",
      hostId: "host-host-00001",
      proxyAllowlisted: false,
    };
    expect(mergeByOwnership(owners, hostCopy, DECISIONS_FIELD_OWNERSHIP)).toEqual(owners);
    expect(splitByOwnership(hostCopy, DECISIONS_FIELD_OWNERSHIP)).toEqual({
      device: hostCopy,
      host: {},
    });
    expect(STORE_KEY_OWNERSHIP.decisions).toBe("device");
  });

  it("keeps the window-states and audit-logs stores' declared owners", () => {
    expect(WINDOW_STATES_STORE_OWNERSHIP).toEqual(
      declaredOwners(SETTING_CATALOG["window-states"].entries)
    );
    expect(AUDIT_LOGS_STORE_OWNERSHIP).toEqual(
      declaredOwners(SETTING_CATALOG["audit-logs"].entries)
    );
  });
});
