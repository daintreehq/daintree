import { hexToOklch, auditSurfaceRamp, auditAccentProminence } from "./shared/theme/oklch.js";
import { contrastRatio, getThemeContrastWarnings } from "./shared/theme/contrast.js";
import { BUILT_IN_APP_SCHEMES } from "./shared/theme/themes.js";
import { BUILT_IN_THEME_SOURCES } from "./shared/theme/builtInThemes/index.js";

const scheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === "bali");
const src = BUILT_IN_THEME_SOURCES.find((s) => s.id === "bali");
const canvas = scheme.tokens["surface-canvas"];
const accent = scheme.tokens["accent-primary"];
const o = hexToOklch(accent);
console.log("CANVAS", canvas);
console.log(
  "ACCENT",
  accent,
  "L=" + o.l.toFixed(3),
  "C=" + o.c.toFixed(3),
  "H=" + o.h.toFixed(1),
  "onCanvas",
  contrastRatio(accent, canvas).toFixed(3)
);
for (const role of ["active", "working", "idle", "waiting"]) {
  const v = src.palette.activity[role];
  console.log("activity." + role, v, contrastRatio(v, canvas).toFixed(3));
}
console.log(
  "placeholder",
  scheme.tokens["text-placeholder"],
  "vsInput",
  contrastRatio(scheme.tokens["text-placeholder"], scheme.tokens["surface-input"]).toFixed(3)
);
console.log(
  "text-muted",
  scheme.tokens["text-muted"],
  "onCanvas",
  contrastRatio(scheme.tokens["text-muted"], canvas).toFixed(3)
);

const surfaces = [
  "surface-grid",
  "surface-sidebar",
  "surface-canvas",
  "surface-panel",
  "surface-panel-elevated",
].map((k) => scheme.tokens[k]);
const ramp = auditSurfaceRamp(surfaces);
const Ls = surfaces.map((s) => hexToOklch(s).l);
console.log("ramp Ls", Ls.map((l) => l.toFixed(4)).join(" "));
console.log(
  "steps",
  Ls.slice(1)
    .map((l, i) => (l - Ls[i]).toFixed(4))
    .join(" ")
);
console.log("span", (Ls[4] - Ls[0]).toFixed(4));

const warnings = getThemeContrastWarnings(scheme);
console.log("WARNINGS:", JSON.stringify(warnings));
