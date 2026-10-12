import type { HostDirectoryEntry, HostPickRequest } from "@shared/types/ipc/hostFiles";

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

export function defaultButtonLabel(request: HostPickRequest): string {
  if (request.buttonLabel) return request.buttonLabel;
  return request.mode === "directory" ? "Choose folder" : "Choose";
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
