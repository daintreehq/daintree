import { z } from "zod";

// Shared by the plugin actions' metadata in pluginActions.ts and their runs in
// pluginActions.impl.ts, which parse their args with these rather than cast them.

/** Bounds the log tail so one call can't ship a whole 500-line ring buffer. */
export const DIAGNOSTICS_LOG_LIMIT_DEFAULT = 50;
const DIAGNOSTICS_LOG_LIMIT_MAX = 500;

export const ReloadPanelArgsSchema = z.object({
  panelId: z.string().min(1).describe("The plugin panel to reload; focus is never assumed."),
});

export const CapturePanelArgsSchema = z.object({
  panelId: z.string().min(1).describe("The plugin panel to capture; focus is never assumed."),
});

export const ValidateArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Plugin directory or manifest file, absolute or project-relative, inside the open project or the managed plugins directory."
    ),
});

export const DiagnosticsArgsSchema = z.object({
  pluginId: z
    .string()
    .min(1)
    .describe(
      "Manifest id, publisher.name. For a project plugin, the manifest id, not its directory."
    ),
  logLimit: z
    .number()
    .int()
    .min(1)
    .max(DIAGNOSTICS_LOG_LIMIT_MAX)
    .optional()
    .describe(
      `Newest log lines to return (default ${DIAGNOSTICS_LOG_LIMIT_DEFAULT}, max ${DIAGNOSTICS_LOG_LIMIT_MAX}).`
    ),
});

export const OpenSettingsArgsSchema = z.object({
  pluginId: z
    .string()
    .min(1)
    .describe(
      "An instance key (exact; an installed plugin's is its manifest id), or the manifest id of this project's own plugin."
    ),
  key: z
    .string()
    .min(1)
    .optional()
    .describe("A setting id from the plugin's contributes.settings to land on."),
  section: z
    .enum(["account", "setup", "custom"])
    .optional()
    .describe(
      "Land on the plugin's account row, setup checklist or custom settings section instead of a key. Ignored when key names a declared setting."
    ),
  page: z
    .string()
    .min(1)
    .optional()
    .describe("With section: custom, a page id the plugin's settings view declares."),
  scope: z
    .enum(["user", "project"])
    .optional()
    .describe(
      "For an installed plugin's custom section or its settings as a whole, which home to open: the plugin manager (user) or Project settings (project)."
    ),
});

export const BackupDatabasesArgsSchema = z.object({
  pluginId: z.string().min(1).describe("The plugin instance key whose data to back up."),
});

export const SetNotificationsSilencedArgsSchema = z.object({
  pluginId: z
    .string()
    .min(1)
    .describe("The plugin instance key, as a notification's context names it."),
  silenced: z.boolean().describe("true to silence, false to let notifications through."),
});
