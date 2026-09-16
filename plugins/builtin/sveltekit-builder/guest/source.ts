import { createSiteBuilderGuest } from "./runtime.js";
import type { GuestBootstrapConfig } from "./types.js";

/** Global the host installs its CDP binding under. */
export const GUEST_BINDING_NAME = "__daintreeSiteBuilderSend";
/** Global the injected runtime publishes its handle under. */
export const GUEST_HANDLE_NAME = "__daintreeSiteBuilderGuest";

/**
 * JSON is not a JavaScript-source subset: U+2028/U+2029 are literal line
 * terminators in source text, and `<` is escaped so the same string is also
 * safe to inline into markup.
 */
function embed(value: GuestBootstrapConfig): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c");
}

/**
 * The runtime ships as source text, not a bundle: the host has no build step
 * for guest code and the page has no module resolver we may borrow. Serialising
 * the factory with `toString()` keeps one authored, typechecked, unit-testable
 * implementation instead of a TypeScript copy and a string copy that drift.
 * `guest-source.test.ts` evaluates the product to prove it stayed self-contained.
 */
export function buildGuestRuntimeSource(config: GuestBootstrapConfig): string {
  const factory = createSiteBuilderGuest.toString();
  // A transform that rewrites functions into calls to a module-scope helper —
  // esbuild's `keepNames`, Istanbul-style coverage — turns the serialised text
  // into a ReferenceError the moment the page runs it. Fail here, where the
  // message can name the cause, rather than in someone's website.
  for (const helper of ["__name(", "__publicField(", "cov_", "__vite_ssr_"]) {
    if (factory.indexOf(helper) !== -1) {
      throw new Error(
        "the guest runtime was built with a transform that injected " +
          helper +
          "; it can no longer be serialised standalone"
      );
    }
  }
  return [
    "(() => {",
    '"use strict";',
    "const scope = globalThis;",
    "const config = " + embed(config) + ";",
    // Re-injection is normal: the host evaluates this into the current document
    // as well as on every new one. The old runtime must let go of its listeners
    // and overlay before the new one starts.
    "const previous = scope[config.handleName];",
    'if (previous && typeof previous.dispose === "function") { try { previous.dispose(); } catch { /* the page may have broken it */ } }',
    "const create = " + factory + ";",
    "const handle = create(config);",
    "Object.defineProperty(scope, config.handleName, {",
    "  value: handle, writable: true, configurable: true, enumerable: false,",
    "});",
    "return true;",
    "})()",
  ].join("\n");
}
