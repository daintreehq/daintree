import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `scrollPill.tsx`, so the bridge shim is on `window` before
// the terminal service and the stores it pulls in evaluate.
installPreviewShims();

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
