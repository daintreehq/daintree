import { hexToOklch } from "./shared/theme/oklch.ts";
import { contrastRatio } from "./shared/theme/contrast.ts";
import { formatHex } from "culori";
const L = (h) => hexToOklch(h).l;

// current ramp
const cur = {
  grid: "#E6D9B4",
  sidebar: "#EDE2C4",
  canvas: "#F3EAD2",
  panel: "#F8F1DE",
  elevated: "#FFFBF0",
};
console.log("=== current ramp L + steps ===");
const order = ["grid", "sidebar", "canvas", "panel", "elevated"];
let prev = null;
for (const k of order) {
  const l = L(cur[k]);
  console.log(
    `${k.padEnd(9)} ${cur[k]} L=${l.toFixed(4)}` +
      (prev !== null ? `  dL=${(l - prev).toFixed(4)}` : "")
  );
  prev = l;
}
console.log(`span = ${(L(cur.elevated) - L(cur.grid)).toFixed(4)}`);

console.log("\n=== verify chosen accent/waiting hue ===");
const acc = hexToOklch("#937305"),
  wait = hexToOklch("#A87529");
console.log(
  `accent #937305 L=${acc.l.toFixed(3)} C=${acc.c.toFixed(3)} H=${acc.h.toFixed(2)} vsCanvas=${contrastRatio("#937305", cur.canvas).toFixed(3)}`
);
console.log(
  `waiting #A87529 L=${wait.l.toFixed(3)} C=${wait.c.toFixed(3)} H=${wait.h.toFixed(2)} vsCanvas=${contrastRatio("#A87529", cur.canvas).toFixed(3)}`
);
