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
