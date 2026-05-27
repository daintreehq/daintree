// Trusted Types policies for the Daintree renderer. The CSP enforces
// `require-trusted-types-for 'script'`, which means every assignment to a
// TT-gated DOM sink (`Element.innerHTML`, `outerHTML`,
// `dangerouslySetInnerHTML.__html`, etc.) must go through a `TrustedHTML`
// produced by a policy whose name is listed in `trusted-types`.
//
// Two policies are registered:
//
// 1. The named policy `daintree-svg` (see `TRUSTED_TYPES_POLICY_NAME` in
//    `shared/config/csp.ts`) is invoked explicitly by `createTrustedHTML`
//    callers. The strings handed to it are either compile-time SVG constants
//    or values returned from the upstream `sanitizeSvg` validator. The
//    callback intentionally does no extra scrubbing — re-sanitizing here
//    would silently mask a regression in the upstream validator.
//
// 2. The `default` policy is what the browser implicitly invokes when a raw
//    string is assigned to a TT-gated sink without going through any named
//    policy. React DOM relies on this for internal sinks like setting
//    `innerHTML` on `<style>` and `<script>` elements (e.g. Radix Popper's
//    `SelectViewport` injects an inline `<style>` for layout vars). Without
//    a default policy those assignments throw `TypeError: This document
//    requires 'TrustedHTML' assignment`. The default is pass-through —
//    first-party React/Radix code is trusted; CSP `script-src` / `style-src`
//    remain the primary defense.
//
// CSP `'allow-duplicates'` lets Vite HMR re-evaluate this module without
// throwing 'Policy with name "<x>" already exists'.
//
// No fallback when `window.trustedTypes` is absent — a silent fallback would
// hide missed sinks. Tests must mock the API before importing this module
// (jsdom does not ship with Trusted Types).

import type { TrustedTypePolicyFactory } from "trusted-types/lib";
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

const passThrough = (input: string): string => input;

const policy = trustedTypesFactory.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
  createHTML: passThrough,
});

trustedTypesFactory.createPolicy("default", {
  createHTML: passThrough,
  createScript: passThrough,
  createScriptURL: passThrough,
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
