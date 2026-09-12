import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";

// Imported first by `preview.tsx`, so the shim is on `window` before any store module
// below it evaluates. ES modules run in import order, and a store that reads
// `window.electron` at module scope would otherwise throw before the harness could
// install anything.
installPreviewShims();

// A harness page must never inherit persisted state. Several stores persist to
// localStorage, and one fixture's preference (the grid's agent-state frame cues)
// would otherwise ride into every page the same browser context loads after it.
try {
  window.localStorage.clear();
  window.sessionStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}
