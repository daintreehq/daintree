import { z } from "zod";
import { CONFIG_BUNDLE_MAX_BYTES } from "../../../shared/types/configBundle.js";

/**
 * Session CALLs a Shell uses to copy this machine's settings to a host
 * (#13346). Session-level, not view-level: Settings copies with no window on
 * the host. The host previews against its own settings and keeps what it
 * previewed; applying names that preview, never a fresh payload.
 */
export const SettingsCopyLinkMethod = {
  /** Validate and diff a bundle against the host's settings; answers a ticket for exactly that. */
  PREVIEW: "settings.copy.preview",
  /** Write what a ticket previewed, unless the host's settings changed since. */
  APPLY: "settings.copy.apply",
} as const;

/**
 * Section ids travel as plain names, not an enum: a host from another build
 * reports a section it doesn't know instead of refusing the whole copy.
 */
const sectionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/);
const ticket = z.string().regex(/^[0-9a-f]{32}$/);
/**
 * Names come from settings the host itself accepts (a custom agent's name has
 * no length limit), so the bound only keeps a broken host from flooding the
 * preview; the whole payload is already capped.
 */
const text = z.string().max(65_536);

export const SettingsCopyPreviewSchema = z.object({
  sections: z
    .record(sectionId, z.unknown())
    .refine((sections) => Object.keys(sections).length <= 64, { message: "too many sections" })
    .refine(
      (sections) => Buffer.byteLength(JSON.stringify(sections), "utf8") <= CONFIG_BUNDLE_MAX_BYTES,
      { message: "settings too large" }
    ),
});
export type SettingsCopyPreviewRequest = z.infer<typeof SettingsCopyPreviewSchema>;

export const SettingsCopyApplySchema = z.object({ ticket });

const previewChange = z.object({
  key: text,
  label: text,
  kind: z.enum(["add", "update"]),
  renamedTo: text.optional(),
  from: text.optional(),
  to: text.optional(),
  note: text.optional(),
});

const previewSkip = z.object({ key: text, label: text, reason: text });

const previewSection = z.object({
  section: sectionId,
  add: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  changes: z.array(previewChange).max(10_000),
  skipped: z.array(previewSkip).max(10_000).optional(),
});

/** The host's preview, validated before this Shell shows any of it. */
export const SettingsCopyPreviewResultSchema = z.object({
  ticket,
  platform: z.string().max(32),
  sections: z.array(previewSection).max(64),
  unknownSections: z.array(sectionId).max(64),
});
export type SettingsCopyPreviewResult = z.infer<typeof SettingsCopyPreviewResultSchema>;

const leaf = z.object({
  key: text,
  status: z.enum(["applied", "unchanged", "skipped", "failed"]),
  reason: text.optional(),
});

/** The host's report, in the shape of a file import's. */
export const SettingsCopyReportSchema = z.object({
  outcome: z.enum(["applied", "rolled-back"]),
  sections: z
    .array(
      z.object({
        section: sectionId,
        present: z.boolean(),
        applied: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        leaves: z.array(leaf).max(10_000),
        errors: z.array(text).max(64),
      })
    )
    .max(64),
  errors: z.array(text).max(64),
  rolledBack: z.boolean(),
  restoreFailed: z.boolean().optional(),
});
