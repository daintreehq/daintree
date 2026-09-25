import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `panelLimitPreview.tsx`, so the shim is on `window` before
// the panel-limit store evaluates. Storage is cleared so a persisted limit from
// an earlier page load can never leak into the fixture's thresholds.
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
