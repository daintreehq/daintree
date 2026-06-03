import { hexToOklch } from "./shared/theme/oklch.ts";
import { contrastRatio } from "./shared/theme/contrast.ts";

const canvas = "#E4EAD2";
const input = "#F2F6E8";
const candidates = {
  "accent #22894A": "#22894A",
  "accent #239049": "#239049",
  "active #168A3C": "#168A3C",
  "active #178D3E": "#178D3E",
  "waiting #A87E12": "#A87E12",
  "waiting #9C7510": "#9C7510",
  "idle #6B7D6E": "#6B7D6E",
  "idle #687A6B": "#687A6B",
};
for (const [k, v] of Object.entries(candidates)) {
  const o = hexToOklch(v);
  console.log(
    k.padEnd(18),
    "L=" + o.l.toFixed(3),
    "C=" + o.c.toFixed(3),
    "H=" + o.h.toFixed(1),
    "vsCanvas=" + contrastRatio(v, canvas).toFixed(3),
    "vsInput=" + contrastRatio(v, input).toFixed(3)
  );
}
// placeholder candidates over input #F2F6E8
console.log("--- placeholder over input ---");
for (const v of ["#6B7D6E", "#637560", "#5C7460", "#647560"]) {
  console.log(
    "placeholder " + v,
    contrastRatio(v, input).toFixed(3),
    "vsCanvas",
    contrastRatio(v, canvas).toFixed(3)
  );
}
