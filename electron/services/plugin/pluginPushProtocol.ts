/**
 * Wire shape of batched plugin pushes, shared by main and the preload.
 *
 * Every push on the `plugin:{pluginId}:{channel}` transport — broadcasts,
 * `postToPanel`, process streams — is delivered inside one message on this
 * channel, as an ordered array of `[fullChannel, envelope]` entries. The
 * preload replays each entry through the listener registered for
 * `fullChannel`, so per-panel filtering is unchanged.
 *
 * Deliberately outside the `plugin:` namespace so no plugin id can collide
 * with it.
 */
export const PLUGIN_PUSH_BATCH_CHANNEL = "plugin-push:batch";

export type PluginPushBatchEntry = readonly [channel: string, envelope: unknown];
