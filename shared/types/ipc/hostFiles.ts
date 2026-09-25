export interface ListHostDirectoryPayload {
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
  /** Label of the confirming button; defaults per mode. */
  buttonLabel?: string;
  /** Absolute host path to start in; falls back to the host's home. */
  defaultPath?: string;
  /** File-mode extension filters, as the native dialog takes them. */
  filters?: Array<{ name: string; extensions: string[] }>;
}
