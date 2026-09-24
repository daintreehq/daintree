import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `typingLocator.tsx`, so the bridge shim is on `window`
// before any store module evaluates.
installPreviewShims();

try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
