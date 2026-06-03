import { contrastRatio } from "./shared/theme/contrast.ts";
const input = "#F2F6E8";
const canvas = "#E4EAD2";
// placeholder should be ~3:1 -> lighter/muted. text-muted is #5C7460 (4.6 over input).
for (const v of ["#7A8C7D", "#768A79", "#728675", "#80927F", "#6F8273"]) {
  console.log(
    "placeholder " + v,
    "vsInput",
    contrastRatio(v, input).toFixed(3),
    "vsCanvas",
    contrastRatio(v, canvas).toFixed(3)
  );
}
