/**
 * Authoring helpers for forge providers.
 *
 * Lives in `shared/` so the main process, the workspace-host UtilityProcess,
 * and a third-party plugin (via the SDK) can all import the same runtime
 * binding without dragging any electron-only code across the process boundary.
 */

import type { ForgeProviderImpl } from "../types/forge.js";

/**
 * Ready-made auth methods for a local/offline forge provider that has no
 * credentials to manage. The base {@link ForgeProviderImpl} contract requires
 * `getCredentials` / `validateCredentials` / `validateToken` even for a
 * token-less, network-free provider; spreading `localAuthStubs` into the impl
 * satisfies all three with the obvious no-op answers:
 *
 * ```ts
 * const provider: ForgeProviderImpl = {
 *   ...localAuthStubs,
 *   parseRemote,
 *   listIssues,
 *   // …the methods that actually do work
 * };
 * ```
 *
 * `getCredentials` resolves `null` (no stored credentials), and both validation
 * methods resolve `{ valid: true }` (nothing to reject). Pair it with
 * `kind: "local"` on the manifest contribution so Preferences labels the
 * provider as deliberately authless. The host never inspects these results
 * for a `"local"` provider, but implementing them keeps the impl a valid
 * structural {@link ForgeProviderImpl}.
 */
export const localAuthStubs: Pick<
  ForgeProviderImpl,
  "getCredentials" | "validateCredentials" | "validateToken"
> = {
  getCredentials: () => Promise.resolve(null),
  validateCredentials: () => Promise.resolve({ valid: true }),
  validateToken: (_token: string) => Promise.resolve({ valid: true }),
};
