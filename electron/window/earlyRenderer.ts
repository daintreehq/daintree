import { getIsE2EDeferRendererLoad } from "../setup/runtimeFlags.js";

/**
 * E2E-only opt-in flag that defers the in-WebContentsView renderer load until
 * per-window services are ready. Playwright's CDP handshake can race
 * concurrent target creation on CI; deferring the WebContentsView load keeps
 * the BrowserWindow sentinel page as the lone target until launch resolves.
 */
export function shouldDeferRendererLoadForE2E(): boolean {
  return getIsE2EDeferRendererLoad();
}
