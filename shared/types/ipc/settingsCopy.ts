import type { PortableSettingsCategoryId } from "../../config/portableSettings.js";
import type { ConfigBundlePreviewSection, ConfigBundleSectionId } from "../configBundle.js";
import type { HostId } from "../remoteHosts.js";

export interface SettingsCopyPreviewPayload {
  hostId: HostId;
  categories: PortableSettingsCategoryId[];
}

/** A value that stayed on this machine because it looked like a secret. Never the value itself. */
export interface SettingsCopyWithheld {
  section: ConfigBundleSectionId;
  /** The env variable or field name, as Settings shows it. */
  name: string;
}

export interface SettingsCopyPreview {
  /** Names this preview on the host; applying it writes exactly what was previewed. */
  ticket: string;
  /** The host's `process.platform`, for reading shortcuts the way it will. */
  hostPlatform: string;
  sections: ConfigBundlePreviewSection[];
  /** Sections the host's Daintree doesn't know: an older build. */
  unknownSections: string[];
  withheld: SettingsCopyWithheld[];
}

export interface SettingsCopyApplyPayload {
  hostId: HostId;
  ticket: string;
}

export interface SettingsCopyStatusPayload {
  hostId: HostId;
}

export interface SettingsCopySectionSummary {
  section: ConfigBundleSectionId;
  applied: number;
  skipped: number;
}

/** What became of one leaf an undo took back, by name only: never a value. */
export interface SettingsCopyUndoLeaf {
  section: ConfigBundleSectionId;
  key: string;
  label: string;
  /** `edited`: changed since the copy, so left as it is. */
  status: "restored" | "unchanged" | "edited" | "failed";
}

export interface SettingsCopyUndone {
  at: number;
  leaves: SettingsCopyUndoLeaf[];
}

/**
 * The last copy the host received, as the host recorded it. `source` is the
 * name the copying machine gave when it connected: who to thank, not proof.
 */
export interface SettingsCopyLastCopy {
  id: string;
  source: string;
  at: number;
  sections: SettingsCopySectionSummary[];
  /** `unavailable`: the host kept no undo for it (too large, or a later copy failed to record). */
  undo: "available" | "unavailable" | "done";
  /** The leaves an undo would take back, by name, while it is available. */
  changed?: Array<{ section: ConfigBundleSectionId; key: string; label: string }>;
  undone?: SettingsCopyUndone;
}

export interface SettingsCopyStatus {
  /** False when the host's Daintree predates this: nothing below is known. */
  supported: boolean;
  /**
   * Categories a copy of everything copyable from this computer would change;
   * null when this computer's settings are too large to compare in one go.
   */
  changes: PortableSettingsCategoryId[] | null;
  lastCopy: SettingsCopyLastCopy | null;
}

export interface SettingsCopyUndoPayload {
  hostId: HostId;
  copyId: string;
}

export interface SettingsCopyUndoResult {
  undone: SettingsCopyUndone;
  lastCopy: SettingsCopyLastCopy;
}
