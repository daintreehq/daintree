import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineIpcNamespace, op } from "../define.js";
import { HOST_FILES_METHOD_CHANNELS } from "./hostFiles.preload.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import type {
  HostDirectoryEntry,
  HostDirectoryListing,
  HostPickerRoots,
  ListHostDirectoryPayload,
} from "../../../shared/types/ipc/hostFiles.js";

/**
 * Directory listings for Daintree's own host file picker. The namespace is
 * host-classified, so in a window attached to a remote host these run on that
 * host and browse its filesystem; locally they browse this machine's.
 */

/** A picker shows a folder, not an index: past this the listing says it stopped. */
export const HOST_DIRECTORY_MAX_ENTRIES = 2_000;
const MAX_PATH_LENGTH = 4_096;
const LSTAT_BATCH = 64;

const PROJECT_DIR_CANDIDATES = ["Projects", "projects", "Developer", "code", "src", "dev", "repos"];
const MAX_PROJECT_PARENT_ROOTS = 6;

function validatePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new AppError({ code: "VALIDATION", message: "A directory path is required" });
  }
  if (value.includes("\0") || !path.isAbsolute(value)) {
    throw new AppError({ code: "INVALID_PATH", message: "The path must be absolute" });
  }
  return path.normalize(value);
}

function listingError(error: unknown): AppError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
      return new AppError({
        code: "NOT_FOUND",
        message: "Directory not found",
        userMessage: "That folder doesn't exist.",
      });
    case "ENOTDIR":
      return new AppError({
        code: "NOT_A_DIRECTORY",
        message: "Not a directory",
        userMessage: "That isn't a folder.",
      });
    case "EACCES":
    case "EPERM":
      return new AppError({
        code: "PERMISSION",
        message: "Permission denied",
        userMessage: "You don't have permission to open that folder.",
      });
    default:
      return new AppError({ code: "INTERNAL", message: "Could not list the directory" });
  }
}

function kindOf(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): HostDirectoryEntry["kind"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

async function describeEntries(
  directory: string,
  names: Array<{ name: string; kind: HostDirectoryEntry["kind"] }>
): Promise<HostDirectoryEntry[]> {
  const out: HostDirectoryEntry[] = [];
  for (let i = 0; i < names.length; i += LSTAT_BATCH) {
    const batch = names.slice(i, i + LSTAT_BATCH);
    const stats = await Promise.all(
      batch.map((entry) => fs.lstat(path.join(directory, entry.name)).catch(() => null))
    );
    batch.forEach((entry, index) => {
      const stat = stats[index];
      out.push({
        name: entry.name,
        kind: entry.kind,
        size: stat && entry.kind === "file" ? stat.size : null,
        mtimeMs: stat ? stat.mtimeMs : null,
      });
    });
  }
  return out;
}

const KIND_ORDER: Record<HostDirectoryEntry["kind"], number> = {
  directory: 0,
  symlink: 1,
  file: 2,
  other: 3,
};

export async function listHostDirectory(
  payload: ListHostDirectoryPayload,
  maxEntries = HOST_DIRECTORY_MAX_ENTRIES
): Promise<HostDirectoryListing> {
  const directory = validatePath(payload?.path);
  const showHidden = payload?.showHidden === true;

  const names: Array<{ name: string; kind: HostDirectoryEntry["kind"] }> = [];
  let truncated = false;
  let dir: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    dir = await fs.opendir(directory);
  } catch (error) {
    throw listingError(error);
  }
  try {
    // Streamed so a directory with a million entries costs the cap, not the directory.
    for await (const entry of dir) {
      if (!showHidden && entry.name.startsWith(".")) continue;
      if (names.length >= maxEntries) {
        truncated = true;
        break;
      }
      names.push({ name: entry.name, kind: kindOf(entry) });
    }
  } catch (error) {
    throw listingError(error);
  } finally {
    await dir.close().catch(() => {});
  }

  const entries = await describeEntries(directory, names);
  entries.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const parent = path.dirname(directory);
  return {
    path: directory,
    parent: parent === directory ? null : parent,
    entries,
    truncated,
  };
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export async function getHostPickerRoots(): Promise<HostPickerRoots> {
  const home = os.homedir();
  let projectsDir: string | null = null;
  for (const name of PROJECT_DIR_CANDIDATES) {
    const candidate = path.join(home, name);
    if (await isDirectory(candidate)) {
      projectsDir = candidate;
      break;
    }
  }

  const roots: HostPickerRoots["roots"] = [{ label: "Home", path: home }];
  const seen = new Set<string>([home]);
  if (projectsDir) {
    roots.push({ label: path.basename(projectsDir), path: projectsDir });
    seen.add(projectsDir);
  }
  // Where this host's projects already live is where a new one most likely goes.
  for (const project of projectStore.getAllProjects()) {
    if (roots.length >= MAX_PROJECT_PARENT_ROOTS) break;
    const parent = path.dirname(project.path);
    if (seen.has(parent) || parent === path.parse(parent).root) continue;
    seen.add(parent);
    if (await isDirectory(parent)) roots.push({ label: path.basename(parent), path: parent });
  }
  const fsRoot = path.parse(home).root;
  if (!seen.has(fsRoot)) roots.push({ label: "Computer", path: fsRoot });

  return { home, projectsDir, roots };
}

export const hostFilesNamespace = defineIpcNamespace({
  name: "hostFiles",
  ops: {
    listDirectory: op(
      HOST_FILES_METHOD_CHANNELS.listDirectory,
      async (payload: ListHostDirectoryPayload): Promise<HostDirectoryListing> =>
        listHostDirectory(payload)
    ),
    getPickerRoots: op(
      HOST_FILES_METHOD_CHANNELS.getPickerRoots,
      async (): Promise<HostPickerRoots> => getHostPickerRoots()
    ),
  },
});

export function registerHostFilesHandlers(): () => void {
  return hostFilesNamespace.register();
}
