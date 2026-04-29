import { contrastRatio, isHexColor } from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";

const NON_TEXT_CONTRAST_THRESHOLD = 3;
const CHIP_LIGHT = "#F5F5F5";
const CHIP_DARK = "#1F1F1F";

export interface BrandChip {
  background: string;
}

export function resolveBrandChip(
  brandColor: string | undefined,
  scheme: AppColorScheme
): BrandChip | null {
  if (!brandColor || !isHexColor(brandColor)) {
    return null;
  }
  const surface = scheme.tokens["surface-panel"];
  if (!isHexColor(surface)) {
    return null;
  }
  if (contrastRatio(brandColor, surface) >= NON_TEXT_CONTRAST_THRESHOLD) {
    return null;
  }
  const candidate = scheme.type === "dark" ? CHIP_LIGHT : CHIP_DARK;
  if (contrastRatio(brandColor, candidate) < NON_TEXT_CONTRAST_THRESHOLD) {
    return null;
  }
  return { background: candidate };
}
