// Before anything can write to a TT-gated DOM sink: Radix menus inject a
// `<style>` through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `preview.tsx`, so the shim is on `window` before any store
// module evaluates. Only ever a harness: with a real bridge on the window this
// page is running inside the app, and clearing storage would clear the user's.
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
