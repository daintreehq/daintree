/* global document */
// Populate heatmap skeleton cells (matches actual 60-day heatmap width)
(function () {
  var g = document.getElementById("skel-heatmap");
  if (!g) return;
  for (var i = 0; i < 60; i++) {
    var c = document.createElement("div");
    c.className = "skel-heat-cell";
    g.appendChild(c);
  }
})();
