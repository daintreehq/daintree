/* global window */
// Fires the skeleton-parsed reveal signal as soon as the classic scripts run
// (skeleton markup is parsed), so the main process can show the window without
// waiting for the deferred module graph to evaluate. Fire-and-forget; the
// dom-ready gate and 5s fallback in createWindow.ts remain as backstops.
(function () {
  try {
    if (window.electron && window.electron.app && window.electron.app.skeletonParsed) {
      window.electron.app.skeletonParsed();
    }
  } catch (_err) {
    // Best-effort: dom-ready backstop covers this.
  }
})();
