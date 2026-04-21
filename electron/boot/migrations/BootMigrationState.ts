import fs from "node:fs";
import path from "node:path";
import { resilientAtomicWriteFileSync } from "../../utils/fs.js";
import type { BootMigrationsMarker } from "./types.js";

/**
 * Reads and writes the `migrations.json` marker that records which boot
 * migrations have completed. Missing or corrupt files are treated as a fresh
 * state so the runner can re-apply every migration.
 */
export class BootMigrationState {
  constructor(private readonly markerPath: string) {}

  /** Returns the path the marker is read/written from. Useful for logging. */
  getMarkerPath(): string {
    return this.markerPath;
  }

  /**
   * Loads the marker from disk. Returns a fresh `{ completed: [] }` if the
   * file is missing, unreadable, or malformed. Duplicate IDs in `completed`
   * are collapsed.
   */
  load(): BootMigrationsMarker {
    let raw: string;
    try {
      raw = fs.readFileSync(this.markerPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(
          `[BootMigrations] Failed to read marker at ${this.markerPath} — ` +
            `treating as fresh state, all migrations will re-run:`,
          err
        );
      }
      return { completed: [] };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<BootMigrationsMarker> | null;
      if (!parsed || !Array.isArray(parsed.completed)) {
        console.warn(
          `[BootMigrations] Malformed marker at ${this.markerPath} — ` +
            `treating as fresh state, all migrations will re-run`
        );
        return { completed: [] };
      }
      const completed = parsed.completed.filter((id): id is string => typeof id === "string");
      return { completed: Array.from(new Set(completed)) };
    } catch (err) {
      console.warn(
        `[BootMigrations] Failed to parse marker at ${this.markerPath} — ` +
          `treating as fresh state, all migrations will re-run:`,
        err
      );
      return { completed: [] };
    }
  }

  /**
   * Persists `completed` atomically. Creates the parent directory if it's
   * missing (first launch may happen before `userData` exists on disk).
   */
  save(completed: readonly string[]): void {
    const dir = path.dirname(this.markerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const deduped = Array.from(new Set(completed));
    const payload: BootMigrationsMarker = { completed: deduped };
    resilientAtomicWriteFileSync(this.markerPath, JSON.stringify(payload));
  }
}
