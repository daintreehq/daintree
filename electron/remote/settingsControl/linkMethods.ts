import { z } from "zod";
import {
  HOST_SETTING_KEYS,
  HostSettingsExpectSchema,
  HostSettingsPatchSchema,
} from "../../../shared/types/hostSettings.js";

/**
 * Session CALLs a Shell uses to read and change a host's own settings by name
 * (#14167). Session-level, like Copy settings: no window or project on the
 * host is needed. A host too old to know them answers `UNSUPPORTED`.
 */
export const SettingsControlLinkMethod = {
  /** The named settings as the host reads them now, with their revisions. */
  READ: "settings.control.read",
  /** Write the named settings, unless any changed since the revisions given. */
  UPDATE: "settings.control.update",
  /**
   * Which keys this host can be asked about (#14706). A host from before it
   * answers `UNSUPPORTED`, and knows only `LEGACY_HOST_SETTING_KEYS`.
   */
  DESCRIBE: "settings.control.describe",
} as const;

export const SettingsControlDescribeSchema = z.object({}).strict();

export const SettingsControlReadSchema = z.object({
  keys: z.array(z.enum(HOST_SETTING_KEYS)).min(1).max(HOST_SETTING_KEYS.length),
});
export type SettingsControlReadRequest = z.infer<typeof SettingsControlReadSchema>;

export const SettingsControlUpdateSchema = z
  .object({ patch: HostSettingsPatchSchema, expect: HostSettingsExpectSchema })
  .refine(({ patch, expect }) => Object.keys(patch).every((key) => key in expect.revisions), {
    message: "every key needs the revision it was read at",
  });
export type SettingsControlUpdateRequest = z.infer<typeof SettingsControlUpdateSchema>;
