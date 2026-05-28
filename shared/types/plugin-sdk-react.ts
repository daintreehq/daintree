/**
 * Reserved entry point for `@daintreehq/plugin-sdk/react`.
 *
 * Holds renderer-facing SDK types only; the runtime implementations live in
 * `src/hooks/` and are wired into the eventual `@daintreehq/plugin-sdk/react`
 * subpath when the SDK is extracted into its own package (F15/F36). Until
 * then, plugin authors can reference these types through the host bundle.
 */

/**
 * Return shape of the `useHostChannel(pluginId, channel)` hook. `invoke`
 * resolves with the validated channel result on success, or `undefined` if
 * the host rejected the call (the rejection is surfaced via `error`). Only
 * the latest `invoke()` updates `loading` / `error` — stale earlier calls are
 * dropped to keep concurrent invocations coherent.
 */
export interface UseHostChannelResult<TArgs, TResult> {
  invoke: (args: TArgs) => Promise<TResult | undefined>;
  loading: boolean;
  error: Error | null;
}
