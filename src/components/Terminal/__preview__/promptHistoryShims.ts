import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `promptHistory.tsx`, so the shim is on `window` before any
// store module evaluates, and so persisted stores start from nothing rather
// than from whatever the last page in this browser context left behind.
const isHarness = !Reflect.get(window, "electron");
installPreviewShims({});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
