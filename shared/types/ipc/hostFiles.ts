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
