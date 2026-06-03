import { hexToOklch } from "./shared/theme/oklch.js";
import { contrastRatio } from "./shared/theme/contrast.js";
const canvas = "#E4EAD2";
const fg = "#FAFCF5";
// Need accent L>=0.55, onCanvas>=3, and fg(#FAFCF5) on accent >=4.5
for (const v of [
  "#22894A",
  "#1F8244",
  "#208044",
  "#1E7E42",
  "#1D7B40",
  "#218546",
  "#1F8345",
  "#20833F",
  "#207F40",
]) {
  const o = hexToOklch(v);
  console.log(
    v,
    "L=" + o.l.toFixed(3),
    "C=" + o.c.toFixed(3),
    "H=" + o.h.toFixed(1),
    "onCanvas=" + contrastRatio(v, canvas).toFixed(3),
    "fgOnAccent=" + contrastRatio(fg, v).toFixed(3)
  );
}
console.log("--- pure white fg on #22894A ---", contrastRatio("#FFFFFF", "#22894A").toFixed(3));
