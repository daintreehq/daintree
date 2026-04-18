import Store from "electron-store";
import type { StoreSchema } from "../store.js";
import fs from "fs";

export const LATEST_SCHEMA_VERSION = 15;

export interface Migration {
  version: number;
  description: string;
  up: (store: Store<StoreSchema>) => void | Promise<void>;
}

export class MigrationRunner {
  constructor(private store: Store<StoreSchema>) {}

  private backupStore(): string | null {
    try {
      const storePath = this.store.path;
      if (!fs.existsSync(storePath)) {
        return null;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${storePath}.backup-${timestamp}`;
      fs.copyFileSync(storePath, backupPath);
      console.log(`[Migrations] Created backup at ${backupPath}`);
      return backupPath;
    } catch (error) {
      console.warn("[Migrations] Failed to create backup:", error);
      return null;
    }
  }

  getCurrentVersion(): number {
    const raw = this.store.get("_schemaVersion", 0);
    const version = Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : 0;
    if (version !== raw) {
      console.warn(`[Migrations] Invalid schema version "${raw}", resetting to 0`);
      this.store.set("_schemaVersion", 0);
    }
    return version;
  }

  async runMigrations(migrations: Migration[]): Promise<void> {
    const current = this.getCurrentVersion();
    const maxKnownVersion = Math.max(...migrations.map((m) => m.version), 0);

    if (current > maxKnownVersion) {
      throw new Error(
        `Store schema version (${current}) is newer than application supports (${maxKnownVersion}). ` +
          `Please upgrade the application or reset your data directory.`
      );
    }

    const pending = migrations.filter((m) => m.version > current);

    if (pending.length === 0) {
      return;
    }

    console.log(`[Migrations] Running ${pending.length} pending migration(s)...`);

    const backupPath = this.backupStore();
    if (backupPath) {
      console.log(`[Migrations] Store backed up, can restore from: ${backupPath}`);
    }

    for (const migration of pending.sort((a, b) => a.version - b.version)) {
      try {
        console.log(`[Migrations] Applying v${migration.version}: ${migration.description}`);
        await migration.up(this.store);
        this.store.set("_schemaVersion", migration.version);
        console.log(`[Migrations] Applied v${migration.version} successfully`);
      } catch (error) {
        console.error(`[Migrations] Migration v${migration.version} failed:`, error);
        if (error instanceof Error) {
          throw new Error(`Migration v${migration.version} failed: ${error.message}`, {
            cause: error,
          });
        }
        throw error;
      }
    }

    console.log("[Migrations] All migrations completed successfully");
  }
}
