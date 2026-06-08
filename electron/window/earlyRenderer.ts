/**
 * E2E-only opt-in flag that defers the in-WebContentsView renderer load until
 * per-window services are ready. Playwright's CDP handshake can race
 * concurrent target creation on CI; deferring the WebContentsView load keeps
 * the BrowserWindow sentinel page as the lone target until launch resolves.
 */
export function shouldDeferRendererLoadForE2E(): boolean {
  // Read `process.env` directly (not via an injected alias) so the esbuild
  // `define` in scripts/build-main.mjs can replace the literal and the strip
  // gate (check-preload-backdoors) sees the name removed from production
  // bundles. Aliased reads (`opts.env.NAME`) evade esbuild's identifier rewrite.
  return process.env.DAINTREE_E2E_DEFER_RENDERER_LOAD === "1";
}
