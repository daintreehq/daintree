// Imported FIRST by recipes.tsx so the bridge shim exists before any store
// module reaches for `window.electron` at evaluation time.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
// The dev CSP requires Trusted Types; without the app's default policy every
// Radix Select viewport's inline <style> throws and the editor never mounts.
import "@/lib/trustedTypesPolicy";

// With a real bridge on the window this page is running inside the app, and
// clearing that origin's storage would clear the user's own persisted state.
const isHarness = !Reflect.get(window, "electron");
installPreviewShims();

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}

/**
 * "Last used 3 days ago" is computed against the wall clock, so a live clock
 * makes two rounds' captures differ in copy the design never touched.
 */
export const FROZEN_NOW = 1_764_000_000_000;
Date.now = () => FROZEN_NOW;
