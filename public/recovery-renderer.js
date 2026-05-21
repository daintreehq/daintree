/* global window, document, URLSearchParams */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var reason = params.get("reason") || "unknown";
  var exitCode = params.get("exitCode") || "—";
  var project = params.get("project") || "";
  var backupTimestamp = params.get("backupTimestamp");
  var panelCountParam = params.get("panelCount");

  function parsePanelCount(raw) {
    if (raw === null || raw === "") return null;
    var n = Number(raw);
    if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
    return n;
  }

  function parseBackupTimestamp(raw) {
    if (raw === null) return null;
    var ts = Number(raw);
    // 8.64e15 is the ECMAScript Date max; beyond it toLocaleString returns "Invalid Date"
    if (!isFinite(ts) || ts <= 0 || ts > 8640000000000000) return null;
    return ts;
  }

  var panelCount = parsePanelCount(panelCountParam);
  var backupTimestampValue = parseBackupTimestamp(backupTimestamp);

  var COPY = {
    oom: {
      title: "Out of memory",
      description:
        "This window ran out of memory and was stopped before it could recover on its own. Reloading usually helps; if it keeps happening, try closing heavy panels or agents before reloading.",
      ctaHint: "Tip: close unused panels to free memory before reloading.",
    },
    "launch-failed": {
      title: "Daintree couldn't start this window",
      description:
        "The renderer failed to launch. This usually points to a damaged install, a missing file, or a security policy blocking startup. Reloading may not help — reinstalling Daintree is the most reliable fix.",
      ctaHint: "Consider reinstalling Daintree if the problem persists.",
    },
    "integrity-failure": {
      title: "Integrity check failed",
      description:
        "The renderer failed a code-integrity check. This means Daintree's files may have been modified, or a security policy is blocking them. Reinstall Daintree from the official source to restore a trusted copy.",
      ctaHint: "Reinstall Daintree from the official source to fix this.",
    },
    killed: {
      title: "Window was terminated",
      description:
        "This window was stopped by the operating system or by another process — for example, Activity Monitor, Task Manager, or a memory-pressure event. Your work wasn't necessarily at fault. Reload to continue.",
      ctaHint: "",
    },
    crashed: {
      title: "Something went wrong",
      description:
        "The renderer process crashed repeatedly. Try reloading the window, or reset workspace state if the problem keeps happening.",
      ctaHint: "",
    },
    "abnormal-exit": {
      title: "Window exited unexpectedly",
      description:
        "The renderer exited unexpectedly. Try reloading; if it keeps happening, resetting workspace state can rule out a bad panel or session.",
      ctaHint: "",
    },
  };

  var copy = COPY[reason] || COPY.crashed;

  var titleEl = document.getElementById("crash-title");
  if (titleEl) {
    titleEl.textContent = copy.title;
  }

  var descEl = document.getElementById("crash-description");
  if (descEl) {
    descEl.textContent = copy.description;
  }

  var hintEl = document.getElementById("cta-hint");
  if (hintEl && copy.ctaHint) {
    hintEl.textContent = copy.ctaHint;
    hintEl.style.display = "";
  }

  var chipEl = document.getElementById("project-chip");
  if (chipEl && project) {
    chipEl.textContent = project;
    chipEl.style.display = "";
  }

  var backupEl = document.getElementById("backup-line");
  var backupFormatted = null;
  if (backupTimestampValue !== null) {
    try {
      backupFormatted = new Date(backupTimestampValue).toLocaleString();
    } catch (_err) {
      backupFormatted = null;
    }
  }
  if (backupEl && backupFormatted) {
    backupEl.textContent = "A workspace backup is available from " + backupFormatted + ".";
    backupEl.style.display = "";
  }

  var detailsEl = document.getElementById("crash-details");
  if (detailsEl) {
    detailsEl.textContent = "Reason: " + reason + "  •  Exit code: " + exitCode;
  }

  var api = window.electron;
  var statusEl = document.getElementById("status");
  var buttonIds = [
    "btn-reload",
    "btn-reset",
    "btn-export-diagnostics",
    "btn-open-logs",
    "btn-reset-confirm",
    "btn-reset-cancel",
  ];

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
    try {
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
    } catch (err) {
      setAllButtonsDisabled(false);
      var message = err && err.message ? err.message : String(err);
      setStatus(failurePrefix + ": " + message, true);
    }
  }

  document.getElementById("btn-reload").addEventListener("click", function () {
    if (api && api.recovery) {
      api.recovery.reloadApp();
    }
  });

  var resetTriggerBtn = document.getElementById("btn-reset");
  var resetConfirmSection = document.getElementById("reset-confirm-section");
  var resetConfirmBtn = document.getElementById("btn-reset-confirm");
  var resetCancelBtn = document.getElementById("btn-reset-cancel");
  var resetDescEl = document.getElementById("reset-confirm-description");
  var resetDetailEl = document.getElementById("reset-confirm-detail");

  function pluralize(n, singular, plural) {
    return n === 1 ? singular : plural;
  }

  function buildResetPreview() {
    if (resetDescEl) {
      var parts = ["This will clear all open sessions and reset sidebar and panel layout."];
      if (panelCount !== null && panelCount > 0) {
        parts.push(
          "You have " +
            panelCount +
            " open " +
            pluralize(panelCount, "session", "sessions") +
            " that won't be recoverable after reset."
        );
      }
      resetDescEl.textContent = parts.join(" ");
    }
    if (resetDetailEl && backupFormatted) {
      resetDetailEl.textContent =
        "A workspace backup from " +
        backupFormatted +
        " will be detached and won't auto-restore after reset.";
      resetDetailEl.style.display = "";
    }
  }

  function openResetConfirm() {
    if (!resetConfirmSection || !resetTriggerBtn) return;
    buildResetPreview();
    resetConfirmSection.removeAttribute("inert");
    resetConfirmSection.classList.add("open");
    resetTriggerBtn.setAttribute("aria-expanded", "true");
    if (resetCancelBtn) {
      resetCancelBtn.focus();
    }
  }

  function closeResetConfirm() {
    if (!resetConfirmSection || !resetTriggerBtn) return;
    resetConfirmSection.classList.remove("open");
    resetConfirmSection.setAttribute("inert", "");
    resetTriggerBtn.setAttribute("aria-expanded", "false");
    resetTriggerBtn.focus();
  }

  if (resetTriggerBtn) {
    resetTriggerBtn.addEventListener("click", openResetConfirm);
  }

  if (resetCancelBtn) {
    resetCancelBtn.addEventListener("click", closeResetConfirm);
  }

  if (resetConfirmBtn) {
    resetConfirmBtn.addEventListener("click", function () {
      if (!api || !api.recovery) return;
      setAllButtonsDisabled(true);
      setStatus("Resetting workspace…", false);
      function handleResetFailure(err) {
        setAllButtonsDisabled(false);
        var message = err && err.message ? err.message : String(err);
        setStatus("Failed to reset workspace: " + message, true);
      }
      try {
        var result = api.recovery.resetAndReload();
        if (result && typeof result.then === "function") {
          result.catch(handleResetFailure);
        }
      } catch (err) {
        handleResetFailure(err);
      }
    });
  }

  var exportBtn = document.getElementById("btn-export-diagnostics");
  if (exportBtn) {
    exportBtn.addEventListener("click", function () {
      runAsync(
        "Collecting diagnostics…",
        function () {
          return api.recovery.exportDiagnostics();
        },
        function (saved) {
          return saved ? "Diagnostics saved" : "Save cancelled";
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
        "Logs opened",
        "Failed to open logs"
      );
    });
  }
})();
