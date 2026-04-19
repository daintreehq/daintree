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
  var statusEl = document.getElementById("status");
  var buttonIds = ["btn-reload", "btn-reset", "btn-export-diagnostics", "btn-open-logs"];

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = "status" + (isError ? " error" : "");
  }

  function setAllButtonsDisabled(disabled) {
    for (var i = 0; i < buttonIds.length; i++) {
      var el = document.getElementById(buttonIds[i]);
      if (el) el.disabled = disabled;
    }
  }

  function runAsync(pendingMessage, promiseFactory, successMessage, failurePrefix) {
    if (!api || !api.recovery) return;
    setAllButtonsDisabled(true);
    setStatus(pendingMessage, false);
    promiseFactory()
      .then(function (result) {
        setStatus(
          typeof successMessage === "function" ? successMessage(result) : successMessage,
          false
        );
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : String(err);
        setStatus(failurePrefix + ": " + message, true);
      })
      .finally(function () {
        setAllButtonsDisabled(false);
      });
  }

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

  var exportBtn = document.getElementById("btn-export-diagnostics");
  if (exportBtn) {
    exportBtn.addEventListener("click", function () {
      runAsync(
        "Collecting diagnostics…",
        function () {
          return api.recovery.exportDiagnostics();
        },
        function (saved) {
          return saved ? "Diagnostics saved." : "Save cancelled.";
        },
        "Failed to export diagnostics"
      );
    });
  }

  var openLogsBtn = document.getElementById("btn-open-logs");
  if (openLogsBtn) {
    openLogsBtn.addEventListener("click", function () {
      runAsync(
        "Opening logs…",
        function () {
          return api.recovery.openLogs();
        },
        "Logs opened.",
        "Failed to open logs"
      );
    });
  }
})();
