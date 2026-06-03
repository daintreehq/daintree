import { hexToOklch } from "./shared/theme/oklch.ts";
import { contrastRatio } from "./shared/theme/contrast.ts";
import { formatHex, oklch as oklchMode, converter } from "culori";

const toHex = (l, c, h) => formatHex({ mode: "oklch", l, c, h }).toUpperCase();

function show(label, hex) {
  const o = hexToOklch(hex);
  console.log(
    `${label.padEnd(30)} ${hex}  L=${o.l.toFixed(4)} C=${o.c.toFixed(4)} H=${o.h.toFixed(2)}`
  );
}
console.log("=== current ===");
show("accent (current)", "#94690A");
show("accent (original)", "#9E7F22");
show("activity.waiting (current)", "#C08010");
show("canvas (current)", "#F3EAD2");
show("text-link (current)", "#6E5400");
show("text-secondary", "#5E4D33");
show("text-muted", "#766338");

console.log("\n=== proposed accent re-derivations (H89) ===");
for (const l of [0.55, 0.56, 0.57, 0.58, 0.59, 0.6, 0.61, 0.62]) {
  const hex = toHex(l, 0.115, 89);
  const o = hexToOklch(hex);
  console.log(
    `L=${l} -> ${hex}  (back L=${o.l.toFixed(3)} C=${o.c.toFixed(3)} H=${o.h.toFixed(2)})  vsCanvas=${contrastRatio(hex, "#F3EAD2").toFixed(3)}`
  );
}
console.log("\n=== proposed waiting re-derivations (H73) ===");
for (const l of [0.58, 0.59, 0.6, 0.61, 0.62]) {
  for (const c of [0.105, 0.11, 0.115]) {
    const hex = toHex(l, c, 73);
    console.log(`L=${l} C=${c} -> ${hex}  vsCanvas=${contrastRatio(hex, "#F3EAD2").toFixed(3)}`);
  }
}
