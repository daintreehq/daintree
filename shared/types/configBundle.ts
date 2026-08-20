import { z } from "zod";

/**
 * Portable configuration bundle (#11889).
 *
 * A single versioned JSON file carrying the configuration worth moving to a
 * second machine: custom agents, per-agent flags, keybinding overrides, theme,
 * notification preferences, the worktree path pattern, and global recipes.
 *
 * Deliberately NOT a dump of `StoreSchema`. Machine-local runtime state (window
 * geometry, open panels, active worktree, install records, audit history) and
 * every secret-bearing value are excluded — see `buildConfigBundle`.
 */

export const CONFIG_BUNDLE_APP_ID = "daintree";

/**
 * Envelope format version. Bumped only when the *container* shape changes, not
 * when a section's payload evolves — sections validate independently so a
 * bundle written by a newer build still applies whatever this build recognises.
 */
export const CONFIG_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Read cap. Larger than the keybinding profile's 100KB because a bundle carries
 * custom theme schemes and recipes, but still far below anything that could
 * stall the main process on parse.
 */
export const CONFIG_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

export const CONFIG_BUNDLE_SECTION_IDS = [
  "userAgentRegistry",
  "agentSettings",
  "keybindingOverrides",
  "appTheme",
  "notificationSettings",
  "worktreeConfig",
  "globalRecipes",
] as const;

export type ConfigBundleSectionId = (typeof CONFIG_BUNDLE_SECTION_IDS)[number];

export const CONFIG_BUNDLE_SECTION_LABELS: Record<ConfigBundleSectionId, string> = {
  userAgentRegistry: "Custom agents",
  agentSettings: "Agent settings",
  keybindingOverrides: "Keyboard shortcuts",
  appTheme: "Theme",
  notificationSettings: "Notifications",
  worktreeConfig: "Worktree path pattern",
  globalRecipes: "Global recipes",
};

export function isConfigBundleSectionId(value: string): value is ConfigBundleSectionId {
  return (CONFIG_BUNDLE_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * Envelope schema. `passthrough` on purpose: a bundle written by a newer build
 * may carry envelope keys this one doesn't know, and stripping them would make
 * a round trip through an older app lossy.
 */
export const ConfigBundleEnvelopeSchema = z
  .object({
    schemaVersion: z.number(),
    exportedAt: z.string(),
    app: z.string(),
    sections: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type ConfigBundleEnvelope = z.infer<typeof ConfigBundleEnvelopeSchema>;

/** Per-leaf outcome of applying one imported value. */
export type ConfigImportLeafStatus = "applied" | "unchanged" | "skipped" | "failed";

export interface ConfigImportLeafResult {
  /** Identifier within the section — an agent id, a recipe id, a setting key. */
  key: string;
  status: ConfigImportLeafStatus;
  /** Why a leaf was skipped or failed. Absent for applied/unchanged. */
  reason?: string;
}

export interface ConfigImportSectionReport {
  section: ConfigBundleSectionId;
  /** False when the bundle carried no payload for this section. */
  present: boolean;
  applied: number;
  unchanged: number;
  skipped: number;
  failed: number;
  leaves: ConfigImportLeafResult[];
  errors: string[];
}

/**
 * `outcome` rather than `ok`: IPC results may not carry `ok`/`success` at the
 * top level (`ForbidIpcEnvelopeKeys`, #6020) because the invoke wrapper already
 * owns that envelope and would silently swallow an inner failure.
 */
export type ConfigImportOutcome = "applied" | "rolled-back";

export interface ConfigImportReport {
  outcome: ConfigImportOutcome;
  sections: ConfigImportSectionReport[];
  errors: string[];
  /** True when a section failed and previously-applied sections were restored. */
  rolledBack: boolean;
}

export interface ConfigBundlePreviewSection {
  section: ConfigBundleSectionId;
  /** Leaves present in the bundle but absent on this machine. */
  add: number;
  /** Leaves present on both sides with a different value. */
  update: number;
  /** Leaves already identical — a re-import of the same bundle is all-unchanged. */
  unchanged: number;
}

/** `ready` carries a bundle to confirm; `rejected` carries the reason in `errors`. */
export type ConfigPreviewOutcome = "ready" | "canceled" | "rejected";

export interface ConfigBundlePreview {
  outcome: ConfigPreviewOutcome;
  /** Base name of the chosen file, so the confirmation can name what it's importing. */
  fileName?: string;
  /**
   * The raw bundle text, handed back so the confirm step can apply exactly what
   * was previewed without a second read of a file that may have changed on disk.
   */
  bundleJson?: string;
  exportedAt?: string;
  schemaVersion?: number;
  sections: ConfigBundlePreviewSection[];
  /** Section keys this build doesn't recognise — reported, never applied. */
  unknownSections: string[];
  errors: string[];
}

export type ConfigExportOutcome = "written" | "canceled";

export interface ConfigExportResult {
  outcome: ConfigExportOutcome;
  filePath?: string;
  sections: ConfigBundleSectionId[];
  /**
   * Dotted paths whose value was withheld because it looked like a secret.
   * Paths only — never the values themselves.
   */
  omittedSecretPaths: string[];
}
