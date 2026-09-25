/**
 * Entry point for everything Remote Hosts starts in the main process. Loaded
 * only through `if (__DAINTREE_REMOTE_HOSTS__) { await import("./remote/boot.js") }`
 * so Windows builds carry none of it. Services register themselves into
 * `./runtime.ts`; core code reaches them from there.
 */
export async function startRemoteHosts(): Promise<void> {}

export async function stopRemoteHosts(): Promise<void> {}
