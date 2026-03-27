/* global window, document, URLSearchParams */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var reason = params.get("reason") || "unknown";
  var exitCode = params.get("exitCode") || "—";

  var detailsEl = document.getElementById("crash-details");
  if (detailsEl) {
    detailsEl.textContent = "Reason: " + reason + "  •  Exit code: " + exitCode;
  }

  var api = window.electron;

  document.getElementById("btn-reload").addEventListener("click", function () {
    if (api && api.recovery) {
      api.recovery.reloadApp();
    }
  });

  document.getElementById("btn-reset").addEventListener("click", function () {
    if (api && api.recovery) {
      api.recovery.resetAndReload();
    }
  });
})();
