// Trusted Types policy for the Daintree renderer. The CSP enforces
// `require-trusted-types-for 'script'`, which means every assignment to a
// TT-gated DOM sink (`Element.innerHTML`, `outerHTML`,
// `dangerouslySetInnerHTML.__html`, etc.) must go through a `TrustedHTML`
// produced by a policy whose name is listed in `trusted-types`.
//
// The single named policy `daintree-svg` (see `TRUSTED_TYPES_POLICY_NAME`
// in `shared/config/csp.ts`) is a pass-through: the strings handed to it are
// either compile-time SVG constants or values returned from the upstream
// `sanitizeSvg` validator. The policy callback intentionally does no extra
// scrubbing — re-sanitizing here would silently mask a regression in the
// upstream validator. CSP `'allow-duplicates'` lets Vite HMR re-evaluate this
// module without throwing.
//
// No fallback when `window.trustedTypes` is absent — a silent fallback would
// hide missed sinks. Tests must mock the API before importing this module
// (jsdom does not ship with Trusted Types).

import { TRUSTED_TYPES_POLICY_NAME } from "@shared/config/csp";

// In a Chromium 83+ renderer this resolves to `window.trustedTypes`. Reading
// off `globalThis` instead lets jsdom-based tests (and Node-environment unit
// tests that transitively import this module) install a stub on globalThis
// without needing a synthetic `window`.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const trustedTypesFactory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory })
  .trustedTypes;

if (!trustedTypesFactory) {
  throw new Error(
    "Trusted Types is not available in this context. The Daintree renderer requires Chromium 83+; jsdom-based tests must stub `globalThis.trustedTypes` before importing this module."
  );
}

const policy = trustedTypesFactory.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
  createHTML: (input: string): string => input,
});

export function createTrustedHTML(html: string): TrustedHTML {
  return policy.createHTML(html);
}

export function setTrustedInnerHTML(el: Element, html: TrustedHTML): void {
  // Reflect.set accepts `unknown`, sidestepping the DOM lib typing of
  // `innerHTML` as `string`. At runtime the browser's TT enforcement
  // recognizes the TrustedHTML brand and allows the assignment.
  Reflect.set(el, "innerHTML", html);
}
