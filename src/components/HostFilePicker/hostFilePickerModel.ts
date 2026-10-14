import type { HostDirectoryEntry, HostPickRequest } from "@shared/types/ipc/hostFiles";
import { pluralize } from "@/lib/pluralize";

/** Host paths are POSIX: remote hosts are macOS or Linux. */
export function joinHostPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

export function isAbsoluteHostPath(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a file passes the request's extension filters (no filters, or `*`, pass everything). */
export function matchesFilters(name: string, filters: HostPickRequest["filters"]): boolean {
  if (!filters || filters.length === 0) return true;
  const extensions = filters.flatMap((filter) =>
    filter.extensions.map((extension) => extension.replace(/^\./, "").toLowerCase())
  );
  if (extensions.length === 0 || extensions.includes("*")) return true;
  return extensions.includes(extensionOf(name));
}

/** An entry that can be opened as a folder. A symlink may point at one; opening it finds out. */
export function isNavigable(entry: HostDirectoryEntry): boolean {
  return entry.kind === "directory" || entry.kind === "symlink";
}

/** An entry that can be chosen in this picker's mode. */
export function isSelectable(entry: HostDirectoryEntry, request: HostPickRequest): boolean {
  if (request.mode === "directory") return isNavigable(entry);
  if (entry.kind === "file") return matchesFilters(entry.name, request.filters);
  return entry.kind === "symlink" && matchesFilters(entry.name, request.filters);
}

/**
 * What the confirm button would choose. A folder picker with nothing
 * selected chooses the folder being shown, as the native dialogs do.
 */
export function resolveChoice(
  request: HostPickRequest,
  directory: string | null,
  selected: readonly HostDirectoryEntry[]
): string[] | null {
  if (directory === null) return null;
  const chosen = selected.filter((entry) => isSelectable(entry, request));
  if (request.mode === "directory") {
    const first = chosen[0];
    return [first ? joinHostPath(directory, first.name) : directory];
  }
  if (chosen.length === 0) return null;
  const picked = request.multiple ? chosen : chosen.slice(0, 1);
  return picked.map((entry) => joinHostPath(directory, entry.name));
}

/**
 * The confirm button's words for what it would pick. A caller's label is kept
 * as written, except that a multi-file picker's label is a verb the count
 * follows ("Attach 3 files"), so the button always says how many it takes.
 */
export function confirmButtonLabel(request: HostPickRequest, choiceCount: number): string {
  if (request.mode === "directory") return request.buttonLabel ?? "Select folder";
  if (!request.multiple) return request.buttonLabel ?? "Select file";
  const verb = request.buttonLabel ?? "Select";
  return choiceCount > 0 ? `${verb} ${pluralize(choiceCount, "file")}` : `${verb} files`;
}

/** The last segment of an absolute host path; "/" for the root. */
export function hostPathLeaf(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (trimmed === "/") return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** The folder holding an absolute host path; null at the root. */
export function hostPathParent(path: string): string | null {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (trimmed === "/") return null;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** Each folder on the way to `path`, root first: `{ name, path }`. */
export function hostPathCrumbs(path: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of path.split("/").filter(Boolean)) {
    at = `${at}/${part}`;
    crumbs.push({ name: part, path: at });
  }
  return crumbs;
}

const NAME_TAIL_CHARS = 8;
const NAME_TAIL_MAX_CHARS = 14;
const COMPOUND_EXTENSIONS = ["tar.gz", "tar.bz2", "tar.xz", "tar.zst", "d.ts"];

/**
 * A name as the part that may give way, and the end and extension that never
 * do, so a long name ellipses in its middle and still says what it is.
 * Folders, dotfiles and names whose "extension" is really part of the name
 * (longer than a dozen characters) have no extension.
 */
export function splitFileName(
  name: string,
  kind: HostDirectoryEntry["kind"]
): { head: string; tail: string; extension: string } {
  let stem = name;
  let extension = "";
  if (kind !== "directory") {
    const lower = name.toLowerCase();
    const compound = COMPOUND_EXTENSIONS.find(
      (ext) => lower.endsWith(`.${ext}`) && name.length > ext.length + 1
    );
    const dot = compound ? name.length - compound.length - 1 : name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 12) {
      stem = name.slice(0, dot);
      extension = name.slice(dot);
    }
  }
  // The end of a long name is where versions and dates live ("…final v3"),
  // so its last few characters stay beside the extension.
  const chars = Array.from(stem);
  let keep = chars.length > 24 ? NAME_TAIL_CHARS : 0;
  // Start the kept end on a word where one begins close by, so it reads as
  // "copy v3", not "py v3".
  if (keep > 0) {
    const end = chars.slice(chars.length - NAME_TAIL_MAX_CHARS);
    const boundary = end.findIndex(
      (ch, i) => i > 0 && /[\s_.-]/.test(end[i - 1]!) && !/[\s_.-]/.test(ch)
    );
    if (boundary !== -1) keep = end.length - boundary;
  }
  return {
    head: chars.slice(0, chars.length - keep).join(""),
    tail: chars.slice(chars.length - keep).join(""),
    extension,
  };
}

export function formatEntrySize(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
