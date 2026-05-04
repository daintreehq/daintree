/* global document, window */
// Wires the stuck-state Reload button. Production CSP forbids inline
// onclick handlers (script-src 'self' has no 'unsafe-inline').
(function () {
  var btn = document.getElementById("skeleton-stuck-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    window.location.reload();
  });
})();
