// eager-import-allow: reads/writes the dev-preview restore manifest via sync fs
// during early startup (first devPreview IPC) and at shutdown (pre-backup tick).
import fs from "node:fs";
import path from "node:path";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";

const BACKUP_DIR = "backups";
const MANIFEST_FILENAME = "dev-preview-manifest.json";

/**
 * One running dev-preview session captured at shutdown. Holds only the spawn
 * metadata needed to re-issue the command on the next launch — there is no
 * process handle and no reattachment. `lastKnownPort` is informational only;
 * the next `ensure()` allocates a fresh port (reusing the old one risks
 * TIME_WAIT / another process having bound it during downtime).
 */
export interface DevPreviewManifestEntry {
  panelId: string;
  projectId: string;
  worktreeId?: string;
  cwd: string;
  devCommand: string;
  env?: Record<string, string>;
  turbopackEnabled?: boolean;
  lastKnownPort: number | null;
  capturedAt: number;
}

function manifestPath(userData: string): string {
  return path.join(userData, BACKUP_DIR, MANIFEST_FILENAME);
}

function isValidEntry(value: unknown): value is DevPreviewManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.panelId === "string" &&
    entry.panelId.length > 0 &&
    typeof entry.projectId === "string" &&
    entry.projectId.length > 0 &&
    typeof entry.cwd === "string" &&
    typeof entry.devCommand === "string" &&
    entry.devCommand.trim().length > 0
  );
}

/**
 * Read the manifest, tolerating any corruption (truncated/partial write,
 * unparseable JSON) as "no manifest". Never throws — a bad file on a crash
 * boot must degrade to a fresh start, not break launch.
 */
export function readDevPreviewManifest(userData: string): DevPreviewManifestEntry[] {
  try {
    const filePath = manifestPath(userData);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

/**
 * Write the manifest atomically. An empty list deletes the file so a stale
 * manifest can't surface restore prompts for sessions that are no longer
 * running. Best-effort: logs and swallows on failure (this runs on the
 * shutdown path and must never block or throw).
 */
export function writeDevPreviewManifest(
  userData: string,
  entries: DevPreviewManifestEntry[]
): void {
  const filePath = manifestPath(userData);
  try {
    if (entries.length === 0) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    resilientAtomicWriteFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8", {
      mode: 0o600,
    });
  } catch (err) {
    console.error("[DevPreviewManifest] Failed to write manifest:", err);
  }
}

/**
 * Read the manifest and delete it in one step. Called once on the first
 * lazy init of the session service: the in-memory copy owns the restore
 * state for this launch, so clearing the file prevents a second launch from
 * re-surfacing the same (now-stale) restore prompts.
 */
export function readAndClearDevPreviewManifest(userData: string): DevPreviewManifestEntry[] {
  const entries = readDevPreviewManifest(userData);
  try {
    const filePath = manifestPath(userData);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best-effort: a leftover file is re-read-and-cleared next launch
  }
  return entries;
}
