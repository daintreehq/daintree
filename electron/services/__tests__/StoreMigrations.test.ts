import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Migration } from "../StoreMigrations.js";
import { MigrationRunner } from "../StoreMigrations.js";

type MockStoreData = Record<string, unknown>;

type MockStore = {
  path: string;
  data: MockStoreData;
  get: (key: string, defaultValue?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
};

function createMockStore(storePath: string, initialData: MockStoreData = {}): MockStore {
  const data = { ...initialData };
  return {
    path: storePath,
    data,
    get: (key, defaultValue) => (key in data ? data[key] : defaultValue),
    set: (key, value) => {
      data[key] = value;
    },
  };
}

describe("MigrationRunner", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-02-10T10:00:00.000Z"));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canopy-migrations-"));
    storePath = path.join(tempDir, "config.json");
    fs.writeFileSync(storePath, JSON.stringify({ ok: true }), "utf8");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns valid current schema version", () => {
    const store = createMockStore(storePath, { _schemaVersion: 3 });
    const runner = new MigrationRunner(store as never);

    expect(runner.getCurrentVersion()).toBe(3);
  });

  it("resets invalid schema version values to zero", () => {
    const store = createMockStore(storePath, { _schemaVersion: "3" });
    const runner = new MigrationRunner(store as never);

    expect(runner.getCurrentVersion()).toBe(0);
    expect(store.data._schemaVersion).toBe(0);
  });

  it("runs only pending migrations in ascending version order", async () => {
    const applied: number[] = [];
    const store = createMockStore(storePath, { _schemaVersion: 1 });
    const runner = new MigrationRunner(store as never);

    const migrations: Migration[] = [
      {
        version: 3,
        description: "third",
        up: async () => {
          applied.push(3);
        },
      },
      {
        version: 2,
        description: "second",
        up: () => {
          applied.push(2);
        },
      },
      {
        version: 1,
        description: "first",
        up: () => {
          applied.push(1);
        },
      },
    ];

    await runner.runMigrations(migrations);

    expect(applied).toEqual([2, 3]);
    expect(store.data._schemaVersion).toBe(3);
  });

  it("throws when store schema version is newer than supported migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 5 });
    const runner = new MigrationRunner(store as never);

    await expect(
      runner.runMigrations([
        {
          version: 2,
          description: "v2",
          up: () => {},
        },
      ])
    ).rejects.toThrow("Store schema version (5) is newer than application supports (2)");
  });

  it("wraps migration errors with version context", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 0 });
    const runner = new MigrationRunner(store as never);

    await expect(
      runner.runMigrations([
        {
          version: 1,
          description: "broken migration",
          up: () => {
            throw new Error("disk full");
          },
        },
      ])
    ).rejects.toThrow("Migration v1 failed: disk full");
  });

  it("creates a backup file before applying pending migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 0 });
    const runner = new MigrationRunner(store as never);

    await runner.runMigrations([
      {
        version: 1,
        description: "noop",
        up: () => {},
      },
    ]);

    const files = fs.readdirSync(tempDir);
    const backupFiles = files.filter((file) => file.startsWith("config.json.backup-"));
    expect(backupFiles).toHaveLength(1);
  });

  it("does nothing when there are no pending migrations", async () => {
    const store = createMockStore(storePath, { _schemaVersion: 2 });
    const runner = new MigrationRunner(store as never);
    const migration = vi.fn();

    await runner.runMigrations([
      {
        version: 1,
        description: "old",
        up: migration,
      },
      {
        version: 2,
        description: "current",
        up: migration,
      },
    ]);

    expect(migration).not.toHaveBeenCalled();
    expect(store.data._schemaVersion).toBe(2);
  });
});
