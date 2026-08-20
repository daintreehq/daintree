/**
 * Event the `app.importConfig` action fires to open the import confirmation.
 *
 * Its own module so the action definitions can reference it without importing
 * `ImportConfigDialog` — and with it the whole dialog/component graph — at
 * action-registration time.
 */
export const IMPORT_CONFIG_EVENT = "daintree:import-config";
