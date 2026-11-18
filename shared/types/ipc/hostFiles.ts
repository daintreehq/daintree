/**
 * Lists the host's home folder without first asking where it is: the
 * listing's `path` is the absolute home. A host from before it refuses the
 * token as a relative path (`INVALID_PATH`).
 */
export const HOST_HOME_PATH = "~";

export interface ListHostDirectoryPayload {
  /** An absolute path on the host, or `HOST_HOME_PATH`. */
  path: string;
  showHidden?: boolean;
}

export interface HostDirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number | null;
  mtimeMs: number | null;
}

export interface HostDirectoryListing {
  path: string;
  parent: string | null;
  entries: HostDirectoryEntry[];
  /** True when the listing stopped at the entry cap. */
  truncated: boolean;
}

export interface HostPickerRoots {
  home: string;
  projectsDir: string | null;
  roots: Array<{ label: string; path: string }>;
}

/** A request to choose paths on the window's host with Daintree's own picker. */
export interface HostPickRequest {
  /** What may be chosen. */
  mode: "directory" | "file";
  /** Allow choosing more than one file (files only). */
  multiple?: boolean;
  title: string;
  /**
   * Label of the confirming button; defaults per mode. In a multi-file picker
   * it is a verb the chosen count follows ("Attach" → "Attach 3 files").
   */
  buttonLabel?: string;
  /** Absolute host path to start in; falls back to the host's home. */
  defaultPath?: string;
  /** File-mode extension filters, as the native dialog takes them. */
  filters?: Array<{ name: string; extensions: string[] }>;
  /**
   * Browse this host instead of the window's own (a project being opened or
   * cloned on another host). Only renderer-made requests set it.
   */
  hostId?: string;
}
