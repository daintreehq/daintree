import { createSiteBuilderGuest } from "./runtime.js";
import type { GuestBootstrapConfig } from "./types.js";

/** Global the host installs its binding function under, in the standalone shape. */
export const GUEST_BINDING_NAME = "__daintreeSiteBuilderSend";
/** Global the runtime publishes its handle under. */
export const GUEST_HANDLE_NAME = "__daintreeSiteBuilderGuest";

/**
 * JSON is not a JavaScript-source subset: U+2028/U+2029 are literal line
 * terminators in source text, and `<` is escaped so the same string is also
 * safe to inline into markup.
 */
function embed(value: unknown): string {
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
 *
 * A transform that rewrites functions into calls to a module-scope helper —
 * esbuild's `keepNames`, Istanbul-style coverage — turns the serialised text
 * into a ReferenceError the moment the page runs it. Fail here, where the
 * message can name the cause, rather than in someone's website.
 */
function serialisedFactory(): string {
  const factory = createSiteBuilderGuest.toString();
  for (const helper of ["__name(", "__publicField(", "cov_", "__vite_ssr_"]) {
    if (factory.indexOf(helper) !== -1) {
      throw new Error(
        "the guest runtime was built with a transform that injected " +
          helper +
          "; it can no longer be serialised standalone"
      );
    }
  }
  return factory;
}

/**
 * The body the host's prelude wraps (`electron/services/sitePreview/guestRuntime.ts`).
 *
 * The prelude declares `api` in the scope this body is spliced into and
 * addresses the envelope: session id and epoch are baked in per install and the
 * sequence is counted by the prelude. This body adapts the runtime to that —
 * events go out through `api.post`, and the host's mode and dispose calls reach
 * the runtime through the hooks it installs on `api`.
 *
 * It must not declare `api` itself or read the CDP binding directly; either
 * would route around the prelude's numbering. That is a correctness contract
 * for this runtime, not a protection against the page: anything in the main
 * world can call the binding, and the host treats what it receives as
 * untrusted observation accordingly.
 *
 * It relies on `api.setMode` working without a receiver — it is captured and
 * called bare. The prelude's closure over `api` guarantees that today.
 */
export function buildGuestRuntimeBody(): string {
  return [
    '"use strict";',
    "const create = " + serialisedFactory() + ";",
    "const guest = create(",
    "  {",
    "    protocolVersion: api.protocolVersion,",
    "    sessionId: api.sessionId,",
    "    documentEpoch: api.documentEpoch,",
    "    mode: api.mode,",
    '    bindingName: "",',
    "    handleName: " + embed(GUEST_HANDLE_NAME) + ",",
    "  },",
    "  { post: (event) => api.post(event) }",
    ");",
    "const hostSetMode = api.setMode;",
    "api.setMode = (next) => { hostSetMode(next); guest.setMode(next); };",
    "api.reselect = (loc, index) => guest.reselect(loc, index);",
    "api.clearSelection = () => guest.clearSelection();",
    "api.dispose = () => guest.dispose();",
    "api.guest = guest;",
  ].join("\n");
}

/**
 * A complete, self-contained script: the runtime plus its own envelope, talking
 * to the binding directly. Not what the host installs — see
 * {@link buildGuestRuntimeBody} — but the shape that proves the serialised
 * runtime stands on its own with nothing around it.
 */
export function buildStandaloneGuestSource(config: GuestBootstrapConfig): string {
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
    "const create = " + serialisedFactory() + ";",
    "const handle = create(config);",
    "Object.defineProperty(scope, config.handleName, {",
    "  value: handle, writable: true, configurable: true, enumerable: false,",
    "});",
    "return true;",
    "})()",
  ].join("\n");
}
