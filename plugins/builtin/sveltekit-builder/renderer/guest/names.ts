/**
 * Globals the guest runtime and its host agree on by name.
 *
 * Their own module so the built asset (`entry.ts`) and the plugin's other code
 * share one definition without the asset pulling in anything else.
 */

/** Global the host installs its binding function under, in the standalone shape. */
export const GUEST_BINDING_NAME = "__daintreeSiteBuilderSend";
/** Global the runtime publishes its handle under. */
export const GUEST_HANDLE_NAME = "__daintreeSiteBuilderGuest";
