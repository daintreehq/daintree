import { contrastRatio } from "./shared/theme/contrast.js";
console.log("white on #218546", contrastRatio("#FFFFFF", "#218546").toFixed(3));
console.log("FAFCF5 on #218546", contrastRatio("#FAFCF5", "#218546").toFixed(3));
