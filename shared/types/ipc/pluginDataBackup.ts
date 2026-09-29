/**
 * What a "Back up data…" request did. Errors are thrown rather than returned,
 * so each outcome here is one the renderer reports differently: nothing on
 * disk yet, a dismissed dialog (reported not at all), or the files written.
 */
export type PluginDataBackupOutcome =
  | { status: "no-data"; pluginName: string }
  | { status: "cancelled" }
  | { status: "saved"; pluginName: string; paths: string[] };
