// The host-owned "Back up data…" entry on a plugin panel's menus: snapshot
// every database the plugin has actually created to a place the user picks.
// Nothing here opens a database for writing or creates one, so backing up a
// plugin that has never run leaves no file behind.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PluginDatabaseLocation } from "../../../shared/types/plugin.js";
import type { PluginDataBackupOutcome } from "../../../shared/types/ipc/pluginDataBackup.js";
import { databaseError } from "../../../shared/utils/pluginDatabaseHandle.js";
import {
  openPluginDatabase,
  resolvePluginDatabaseLocation,
  type PluginDatabaseDeclaration,
} from "./pluginDatabase.js";

/** Everything main knows about a loaded plugin that a backup needs. */
export interface PluginDataBackupSource {
  /** Manifest id, used in the backup file names and project database paths. */
  manifestId: string;
  displayName: string;
  declarations: readonly PluginDatabaseDeclaration[];
  /** The bound project root; null for an app-global plugin. */
  projectRoot: string | null;
  /** The plugin instance's own data directory. */
  dataDir: string;
}

export interface PluginDataBackupPicker {
  /** Where to write the one database, or null when the dialog is dismissed. */
  chooseFile(defaultPath: string): Promise<string | null>;
  /** The folder to write several databases into, or null when dismissed. */
  chooseFolder(defaultPath: string): Promise<string | null>;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** Local time as `YYYY-MM-DD_HHmmss`, sortable and safe in a file name everywhere. */
export function backupTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * A manifest id reduced to what every file system accepts: a scoped name's
 * `@` and `/` would otherwise read as a directory on the way to the file.
 */
export function backupFileStem(manifestId: string): string {
  const stem = manifestId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-+$/, "");
  return stem.length > 0 ? stem : "plugin";
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * A backup failure whose message is fit to show the user as it stands. What
 * SQLite or the file system said is logged in main, never shown.
 */
export class PluginDataBackupError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "PluginDataBackupError";
  }
}

function describeFailure(
  error: unknown,
  databaseId: string,
  target: string
): PluginDataBackupError {
  if (error instanceof PluginDataBackupError) return error;
  const code = (error as { code?: unknown }).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new PluginDataBackupError(
      `Daintree couldn't write to ${path.dirname(target)}.`,
      "DESTINATION_NOT_WRITABLE"
    );
  }
  if (code === "ENOSPC") {
    return new PluginDataBackupError(
      `The disk ran out of space while writing ${path.basename(target)}.`,
      "DESTINATION_FULL"
    );
  }
  console.error(`[PluginDataBackup] database "${databaseId}" failed to copy:`, error);
  return new PluginDataBackupError(
    `Database "${databaseId}" couldn't be copied.`,
    typeof code === "string" ? code : "BACKUP_FAILED"
  );
}

interface ExistingDatabase {
  declaration: PluginDatabaseDeclaration;
  location: PluginDatabaseLocation;
}

function resolveExisting(
  source: PluginDataBackupSource,
  declaration: PluginDatabaseDeclaration
): Promise<PluginDatabaseLocation> {
  return resolvePluginDatabaseLocation({
    declaration,
    manifestId: source.manifestId,
    projectRoot: source.projectRoot,
    dataDir: source.dataDir,
    existingOnly: true,
  });
}

function sourceUnavailable(
  source: PluginDataBackupSource,
  declaration: PluginDatabaseDeclaration,
  error: unknown
): PluginDataBackupError {
  const code = (error as { code?: unknown }).code;
  console.error(`[PluginDataBackup] database "${declaration.id}" failed to resolve:`, error);
  return new PluginDataBackupError(
    `Database "${declaration.id}" isn't a plain file where ${source.displayName} keeps it, so nothing was copied.`,
    typeof code === "string" ? code : "SOURCE_UNAVAILABLE"
  );
}

/**
 * The declared databases that exist on disk, resolved read-only. A database
 * the plugin has not created yet is skipped, and so is a project database of a
 * plugin with no project, which can never have been created. Anything else —
 * a symlinked file, a path that escapes its root — is a real failure and throws.
 */
async function locateExistingPluginDatabases(
  source: PluginDataBackupSource
): Promise<ExistingDatabase[]> {
  const found: ExistingDatabase[] = [];
  for (const declaration of source.declarations) {
    try {
      found.push({ declaration, location: await resolveExisting(source, declaration) });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "DB_NOT_FOUND" || code === "PROJECT_UNAVAILABLE") continue;
      throw sourceUnavailable(source, declaration, error);
    }
  }
  return found;
}

/** Files SQLite pairs with a database by name, and would replay into a new one. */
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

/**
 * Put the finished snapshot at `target`. Without replacement the publish is
 * exclusive — a hard link, or an exclusive copy where the disk has none — so
 * a file that appeared at `target` after the early check is never overwritten.
 */
async function publishSnapshot(staged: string, target: string, replace: boolean): Promise<void> {
  if (replace) {
    await fsp.rename(staged, target);
    return;
  }
  try {
    await fsp.link(staged, target);
    return;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "EEXIST") throw destinationExists(target);
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "EMLINK") {
      throw error;
    }
  }
  try {
    await fsp.copyFile(staged, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") throw destinationExists(target);
    throw error;
  }
}

function destinationExists(target: string): PluginDataBackupError {
  return new PluginDataBackupError(
    `${path.basename(target)} already exists in ${path.dirname(target)}.`,
    "DESTINATION_EXISTS"
  );
}

/**
 * Snapshot one database to `destination` through SQLite's online backup, from
 * a read-only connection, so a plugin writing at the same moment neither
 * blocks for long nor leaves a torn copy. The copy is made in a private
 * directory beside the destination and only then published there.
 */
async function snapshotDatabase(
  source: PluginDataBackupSource,
  existing: ExistingDatabase,
  destination: string,
  options: { replace: boolean }
): Promise<string> {
  try {
    return await snapshotDatabaseOnce(source, existing, destination, options);
  } catch (error) {
    throw describeFailure(error, existing.declaration.id, destination);
  }
}

async function snapshotDatabaseOnce(
  source: PluginDataBackupSource,
  { declaration }: ExistingDatabase,
  destination: string,
  options: { replace: boolean }
): Promise<string> {
  if (!path.isAbsolute(destination)) {
    throw databaseError("VALIDATION", "the backup destination must be an absolute path");
  }
  // Resolved again now the dialog has closed: the directories on the way to
  // the source could have changed while it was open.
  let location: PluginDatabaseLocation;
  try {
    location = await resolveExisting(source, declaration);
  } catch (error) {
    throw sourceUnavailable(source, declaration, error);
  }

  const parent = await fsp.realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const existingTarget = await fsp.lstat(target).catch(() => null);
  if (existingTarget) {
    // By identity, not name: a case-insensitive disk or a hard link names
    // the source under a different spelling.
    const sourceStat = await fsp.stat(location.path);
    const targetStat = await fsp.stat(target).catch(() => null);
    if (targetStat && sameFile(targetStat, sourceStat)) {
      throw new PluginDataBackupError(
        `That file is the plugin's database "${location.id}" itself. Choose another location.`,
        "DESTINATION_IS_SOURCE"
      );
    }
    if (!options.replace) throw destinationExists(target);
    if (existingTarget.isSymbolicLink() || !existingTarget.isFile()) {
      throw new PluginDataBackupError(
        `${path.basename(target)} isn't a plain file, so it wasn't replaced. Choose another name.`,
        "DESTINATION_NOT_FILE"
      );
    }
  }
  // A journal left beside the name belongs to whatever database was there
  // before; SQLite would replay it into the copy the next time it is opened.
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (await fsp.lstat(`${target}${suffix}`).catch(() => null)) {
      throw new PluginDataBackupError(
        `${path.basename(target)}${suffix} is next to that name and would be mixed into the copy. Choose another name or folder.`,
        "DESTINATION_HAS_JOURNAL"
      );
    }
  }

  const stage = await fsp.mkdtemp(path.join(parent, ".daintree-backup-"));
  try {
    const database = await openPluginDatabase(location, {
      readonly: true,
      revalidate: () => resolveExisting(source, declaration),
      // The destination is this private directory, created a moment ago.
      prepareBackup: async (destPath) => destPath,
    });
    let staged: string;
    try {
      staged = (await database.backup(path.join(stage, "snapshot.db"))).path;
    } finally {
      await database.close();
    }
    await publishSnapshot(staged, target, options.replace);
    return target;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
  }
}

/**
 * Back up every existing database of one plugin. One database asks for a file;
 * several ask for a folder and write one timestamped file each, so a second
 * backup never lands on the first.
 */
export async function backupPluginData(
  source: PluginDataBackupSource,
  picker: PluginDataBackupPicker,
  options: { downloadsDir: string; now?: Date }
): Promise<PluginDataBackupOutcome> {
  const databases = await locateExistingPluginDatabases(source);
  if (databases.length === 0) return { status: "no-data", pluginName: source.displayName };

  const stamp = backupTimestamp(options.now ?? new Date());
  const fileName = (id: string) => `${backupFileStem(source.manifestId)}-${id}-${stamp}.db`;

  if (databases.length === 1) {
    const only = databases[0]!;
    const chosen = await picker.chooseFile(
      path.join(options.downloadsDir, fileName(only.declaration.id))
    );
    if (chosen === null) return { status: "cancelled" };
    // The save dialog has already asked about replacing an existing file.
    const written = await snapshotDatabase(source, only, chosen, { replace: true });
    return { status: "saved", pluginName: source.displayName, paths: [written] };
  }

  const folder = await picker.chooseFolder(options.downloadsDir);
  if (folder === null) return { status: "cancelled" };
  const paths: string[] = [];
  for (const database of databases) {
    try {
      paths.push(
        await snapshotDatabase(
          source,
          database,
          path.join(folder, fileName(database.declaration.id)),
          { replace: false }
        )
      );
    } catch (error) {
      if (paths.length === 0 || !(error instanceof PluginDataBackupError)) throw error;
      // Said outright: the files already written stay, and a retry adds a new set.
      throw new PluginDataBackupError(
        `${error.message} ${paths.length} of ${databases.length} databases were saved before it stopped.`,
        error.code
      );
    }
  }
  return { status: "saved", pluginName: source.displayName, paths };
}
