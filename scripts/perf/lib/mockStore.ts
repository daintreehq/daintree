import fs from "fs";
import os from "os";
import path from "path";
import type { StoreSchema } from "../../../electron/store";

export type MockStoreData = Record<string, unknown>;

export interface MockStore {
  path: string;
  data: MockStoreData;
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}

/**
 * Creates an in-memory mock of electron-store v11 semantics.
 * - `get(key)` returns the stored value or `defaultValue`.
 * - `set(key, value)` throws if `value` is `undefined` (matches v11 behavior).
 * - `delete(key)` removes the key from the data map.
 */
export function createMockStore(storePath?: string, initialData: MockStoreData = {}): MockStore {
  const data: MockStoreData = { ...initialData };
  const resolvedPath =
    storePath ??
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "perf-migration-")), "config.json");

  // Ensure the file exists so MigrationRunner.backupStore() can copy it.
  if (!fs.existsSync(resolvedPath)) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, JSON.stringify(data), "utf8");
  }

  return {
    path: resolvedPath,
    data,
    get: (key, defaultValue) => (key in data ? data[key] : defaultValue),
    set: (key, value) => {
      if (value === undefined) {
        throw new Error(
          `electron-store v11 does not allow store.set("${key}", undefined) — use delete() instead`
        );
      }
      data[key] = value;
    },
    delete: (key) => {
      delete data[key];
    },
  };
}

/**
 * Creates a fresh mock store pre-loaded with a heavy migration fixture.
 * Each call creates a new temp directory (isolated for each perf iteration).
 */
export function createMockStoreWithFixture(fixture: StoreSchema): MockStore {
  return createMockStore(undefined, fixture as unknown as MockStoreData);
}
