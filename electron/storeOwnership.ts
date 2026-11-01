import {
  SETTING_CATALOG,
  type SettingDeclaration,
  type SettingEntry,
  type SettingOwner,
} from "../shared/config/settingOwnership.js";
import type { AuditLogsStoreSchema, StoreSchema, WindowStatesStoreSchema } from "./store.js";

export type { SettingOwner };

/**
 * Main's ownership tables, derived from the shared catalog
 * (`shared/config/settingOwnership.ts`). Each is held exactly to its schema: a
 * store key or field the catalog doesn't declare, or one it declares that the
 * schema no longer has, fails typecheck.
 */
function exactlyOver<Keys extends PropertyKey>() {
  return <T extends Record<Keys, unknown>>(table: T & Record<Exclude<keyof T, Keys>, never>): T =>
    table;
}

/** A split key is `split` when its fields' owners differ. */
function entryOwner(entry: SettingEntry): SettingOwner | "split" {
  if (!("fields" in entry)) return entry.owner;
  const owners = new Set(Object.values(entry.fields).map((field) => field.owner));
  if (owners.size > 1) return "split";
  return owners.has("device") ? "device" : "host";
}

function entryOwners<T extends Readonly<Record<string, SettingEntry>>>(entries: T) {
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [key, entryOwner(entry)])
  ) as { readonly [K in keyof T]: SettingOwner | "split" };
}

function declaredOwners<T extends Readonly<Record<string, SettingDeclaration>>>(declarations: T) {
  return Object.fromEntries(
    Object.entries(declarations).map(([key, declaration]) => [key, declaration.owner])
  ) as { readonly [K in keyof T]: SettingOwner };
}

const config = SETTING_CATALOG.config.entries;

export const STORE_KEY_OWNERSHIP = exactlyOver<keyof StoreSchema>()(entryOwners(config));

export const TERMINAL_CONFIG_FIELD_OWNERSHIP = exactlyOver<keyof StoreSchema["terminalConfig"]>()(
  declaredOwners(config.terminalConfig.fields)
);

export const APP_STATE_FIELD_OWNERSHIP = exactlyOver<keyof StoreSchema["appState"]>()(
  declaredOwners(config.appState.fields)
);

export const DECISIONS_FIELD_OWNERSHIP = exactlyOver<
  keyof NonNullable<StoreSchema["decisions"]>
>()(declaredOwners(config.decisions.fields));

export const WINDOW_STATES_STORE_OWNERSHIP = exactlyOver<keyof WindowStatesStoreSchema>()(
  declaredOwners(SETTING_CATALOG["window-states"].entries)
);

export const AUDIT_LOGS_STORE_OWNERSHIP = exactlyOver<keyof AuditLogsStoreSchema>()(
  declaredOwners(SETTING_CATALOG["audit-logs"].entries)
);

export function ownerOfStoreKey(key: keyof StoreSchema): SettingOwner | "split" {
  return STORE_KEY_OWNERSHIP[key];
}
