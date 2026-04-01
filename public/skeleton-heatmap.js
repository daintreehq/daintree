// Populate heatmap grid cells (60×7 = 420 cells)
(function () {
  var g = document.getElementById("skel-heatmap");
  if (!g) return;
  for (var i = 0; i < 420; i++) {
    var c = document.createElement("div");
    c.className = "skel-heat-cell";
    g.appendChild(c);
  }
})();
