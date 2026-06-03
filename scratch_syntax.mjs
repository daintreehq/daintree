import { contrastRatio } from "./shared/theme/contrast.ts";
const canvasCur = "#F3EAD2",
  canvasLow = "#EFE4C8";
const syntax = {
  comment: "#6B6050",
  punctuation: "#74624A",
  number: "#8C5E0E",
  string: "#3A7026",
  operator: "#1C7264",
  keyword: "#90486A",
  function: "#2A6796",
  link: "#2A6796",
  quote: "#766338",
};
const text = {
  secondary: "#5E4D33",
  muted: "#766338",
  "text-link": "#6E5400",
  "text-placeholder": "#8E7C54",
};
import { hexToOklch } from "./shared/theme/oklch.ts";
console.log("canvasLow #EFE4C8 L=", hexToOklch(canvasLow).l.toFixed(4));
console.log("role".padEnd(14), "curCanvas", "lowCanvas");
for (const [k, v] of Object.entries(syntax)) {
  const soft = k === "comment" || k === "quote";
  console.log(
    k.padEnd(14),
    contrastRatio(v, canvasCur).toFixed(3),
    "   ",
    contrastRatio(v, canvasLow).toFixed(3),
    "  floor",
    soft ? 3.0 : 4.5
  );
}
for (const [k, v] of Object.entries(text)) {
  console.log(
    k.padEnd(14),
    contrastRatio(v, canvasCur).toFixed(3),
    "   ",
    contrastRatio(v, canvasLow).toFixed(3)
  );
}
