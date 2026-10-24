// Setting definitions and setup steps.

import { z } from "zod";
import { SAFE_ID_PATTERN } from "../pluginIdentifiers.js";
import { PluginConnectionIdSchema } from "./accounts.js";

/** Setting ids carry no length cap of their own, so a reference to one takes none either. */
const SetupSettingKeySchema = z.string().min(1).regex(SAFE_ID_PATTERN);

export const SetupStepSettingDoneSchema = z
  .object({ kind: z.literal("setting"), key: SetupSettingKeySchema })
  .strict();

export const SetupStepAccountDoneSchema = z
  .object({ kind: z.literal("account"), connection: PluginConnectionIdSchema.optional() })
  .strict();

export const SetupStepContextDoneSchema = z
  .object({ kind: z.literal("context"), when: z.string().trim().min(1).max(1024) })
  .strict();

export const SetupStepSettingsActionSchema = z
  .object({ kind: z.literal("settings"), key: SetupSettingKeySchema.optional() })
  .strict();

export const SetupStepCommandActionSchema = z
  .object({ kind: z.literal("command"), actionId: z.string().min(1).max(200) })
  .strict();

/**
 * `contributes.setup` manifest entry (#13824). A step names how the host tells
 * it's done and what clicking it does; whether those references resolve — a
 * declared setting, a declared account, a clause that parses, the plugin's own
 * command — is checked by the manifest-level `superRefine`.
 */
export const SetupStepContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(200).optional(),
    done: z.discriminatedUnion("kind", [
      SetupStepSettingDoneSchema,
      SetupStepAccountDoneSchema,
      SetupStepContextDoneSchema,
    ]),
    action: z
      .discriminatedUnion("kind", [SetupStepSettingsActionSchema, SetupStepCommandActionSchema])
      .optional(),
  })
  .strict();

/**
 * One `contributes.settings` field declaration (#9301). `type` is optional
 * (renders as a text field when omitted); the legacy `secret: true` flag is
 * normalized to `type: "secret"` by the transform so downstream consumers only
 * switch on `type`. A plain object (not `discriminatedUnion`) is used because
 * `type` is optional on the string/number/boolean branch. Strict so a misspelled
 * field key surfaces as a manifest error rather than silently dropping.
 */
export const SettingDefinitionObjectSchema = z
  .object({
    // Constrained to the shared safe-id grammar so a declared setting id can
    // always be referenced by a `${settings:id}` token — the MCP supervisor's
    // substitution gate (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) only
    // matches `[a-zA-Z0-9._-]+`, so an id outside that grammar could be declared
    // but never resolved at runtime.
    id: z.string().min(1).regex(SAFE_ID_PATTERN),
    type: z
      .enum(["string", "number", "boolean", "enum", "json", "secret", "path", "directory", "file"])
      .optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    default: z.unknown().optional(),
    scope: z.enum(["user", "project", "local"]).default("user"),
    options: z.array(z.string().min(1)).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    // Advisory existence check for path/directory/file fields — the form flags a
    // stored path that no longer resolves; it does not gate saving.
    mustExist: z.boolean().optional(),
    // File-extension filter for type: "file" (no leading dot). Non-empty when present.
    extensions: z.array(z.string().min(1)).min(1).optional(),
    secret: z.boolean().optional(),
    // Drives the panel "needs setup" strip and `host.settings.missingRequired`.
    required: z.boolean().optional(),
    // "view": the plugin's own settings section edits this value, so the
    // generated form leaves it out rather than showing it twice.
    editor: z.enum(["form", "view"]).optional(),
  })
  .strict();

/**
 * The validated `contributes.settings` entry: the object base plus the
 * cross-field refinement and the `secret → type: "secret"` normalization.
 * The unrefined {@link SettingDefinitionObjectSchema} is exported separately so
 * the field-consumer contract test can enumerate `.shape` without reaching
 * through the transform wrapper.
 */
export const SettingDefinitionSchema = SettingDefinitionObjectSchema.superRefine((val, ctx) => {
  const effectiveType = val.secret === true ? "secret" : (val.type ?? "string");
  if (effectiveType === "enum" && (!val.options || val.options.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Settings of type "enum" require a non-empty options array',
      path: ["options"],
    });
  }
  if (val.min !== undefined && val.max !== undefined && val.min > val.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Setting min cannot be greater than max",
      path: ["min"],
    });
  }
  // `extensions` narrows the native file chooser — it is only meaningful for
  // `type: "file"`. Reject it on every other type at the manifest gate so a
  // misplaced filter surfaces loudly instead of silently doing nothing.
  // A secret's default would ship in plugin.json — committed to the plugin's
  // repository and readable by anyone who has it — which is the one place a
  // credential must never live. It would also silently stand in for a key the
  // user never entered. Rejected at the gate rather than ignored.
  if (val.default !== undefined && effectiveType === "secret") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Settings of type "secret" cannot declare a default — it would ship in plugin.json. Leave it unset and mark it required instead.',
      path: ["default"],
    });
  }
  if (val.extensions !== undefined && effectiveType !== "file") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Setting "extensions" is only valid for type "file"',
      path: ["extensions"],
    });
  }
}).transform((val) => {
  if (val.secret === true && val.type !== "secret") {
    return { ...val, type: "secret" as const };
  }
  return val;
});
