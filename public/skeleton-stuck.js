/* global document, window, Promise */
// Wires the stuck-state card. Production CSP forbids inline onclick handlers
// (script-src 'self' has no 'unsafe-inline'), and this classic script runs
// before (and without) the module graph, so it reads the bridge directly.
(function () {
  var skeleton = document.getElementById("startup-skeleton");
  var card = skeleton ? skeleton.querySelector(".skeleton-stuck") : null;
  var reloadBtn = document.getElementById("skeleton-stuck-btn");
  var safeModeBtn = document.getElementById("skeleton-stuck-safe-mode-btn");
  var errorEl = document.getElementById("skeleton-stuck-error");
  var app = window.electron && window.electron.app ? window.electron.app : null;

  if (reloadBtn) {
    reloadBtn.addEventListener("click", function () {
      window.location.reload();
    });
  }

  // A reload lands in the same wait when main is what hydration is stuck on;
  // a restart into safe mode is the way out that doesn't need three crashes.
  if (safeModeBtn && app && typeof app.restartInSafeMode === "function") {
    var setBusy = function (busy) {
      safeModeBtn.disabled = busy;
      if (reloadBtn) reloadBtn.disabled = busy;
    };
    safeModeBtn.hidden = false;
    safeModeBtn.addEventListener("click", function () {
      if (errorEl) errorEl.hidden = true;
      setBusy(true);
      var request;
      try {
        request = Promise.resolve(app.restartInSafeMode());
      } catch (err) {
        request = Promise.reject(err);
      }
      request.then(
        function (result) {
          // Accepted: Daintree is going down, so the buttons stay disabled.
          if (!result || result.started !== true) setBusy(false);
        },
        function () {
          setBusy(false);
          if (errorEl) errorEl.hidden = false;
        }
      );
    });
  }

  // When the card actually appears, have main log what startup was still
  // waiting on. `animationstart` is the card's own reveal (it also fires for
  // the reduced-motion zero-length run), so a hidden view reports when it is
  // shown rather than on a timer of its own.
  var canReport = Boolean(app && typeof app.reportStartupStuck === "function");
  if (card && skeleton) {
    var reported = false;
    var waitingForVisible = false;
    var report = function () {
      if (reported || !canReport || !skeleton.isConnected) return;
      var stage = skeleton.getAttribute("data-startup-stage");
      if (stage === "ready") return;
      if (document.visibilityState === "hidden") {
        if (!waitingForVisible) {
          waitingForVisible = true;
          document.addEventListener("visibilitychange", onVisible);
        }
        return;
      }
      reported = true;
      try {
        var sent = app.reportStartupStuck(stage || "before-boot");
        if (sent && typeof sent.catch === "function") sent.catch(function () {});
      } catch (_err) {
        // Best-effort diagnostics: the card itself still works.
      }
    };
    var onVisible = function () {
      if (document.visibilityState === "hidden") return;
      waitingForVisible = false;
      document.removeEventListener("visibilitychange", onVisible);
      report();
    };
    card.addEventListener("animationstart", function (event) {
      if (event.target !== card) return;
      if (skeleton.getAttribute("data-startup-stage") === "ready") return;
      // Loading has stalled and the card is what's live now: a region left
      // busy may keep assistive tech from announcing it or its error line.
      skeleton.setAttribute("aria-busy", "false");
      report();
    });
  }
})();
