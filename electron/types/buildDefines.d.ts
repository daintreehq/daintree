/**
 * Build-time constants replaced by esbuild (scripts/build-main.mjs) and by
 * Vitest's `define`. Scripts run under tsx have neither, so read them through
 * `electron/remote/buildGate.ts` unless the site must fold at build time.
 */

/**
 * Whether Remote Hosts is built in at all (every platform's Shell today). Gate
 * every load of a remote-hosts module with this identifier directly —
 * `if (__DAINTREE_REMOTE_HOSTS__) { await import(...) }` — so esbuild drops the
 * chunk. A const re-exported from another module does not fold across the
 * module boundary.
 */
declare const __DAINTREE_REMOTE_HOSTS__: boolean;

/**
 * Whether the Host role is built in: false in Windows builds, which are only
 * ever a Shell. Gate every load of a Host-only module (the listener, Host
 * mode, the attach bridge) with this identifier directly, as above.
 */
declare const __DAINTREE_REMOTE_HOST_ROLE__: boolean;

/** Source commit the app was built from; a client and host must match. */
declare const __DAINTREE_BUILD_COMMIT__: string;
