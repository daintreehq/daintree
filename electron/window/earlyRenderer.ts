/**
 * Windows E2E only: opt-in flag that defers the in-WebContentsView renderer
 * load until per-window services are ready. The Playwright CDP handshake on
 * Windows CI races concurrent target creation; deferring the WebContentsView
 * load keeps the BrowserWindow sentinel page as the lone target until launch
 * resolves.
 */
export function shouldDeferRendererLoadForE2E(opts: { env: NodeJS.ProcessEnv }): boolean {
  return opts.env.DAINTREE_E2E_DEFER_RENDERER_LOAD === "1";
}
