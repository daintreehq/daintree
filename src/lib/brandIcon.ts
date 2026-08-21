import { contrastRatio, isHexColor } from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";

const NON_TEXT_CONTRAST_THRESHOLD = 3;
const CHIP_LIGHT = "#F5F5F5";

export interface BrandChip {
  /** Contrasting tile painted behind the untouched brand mark (dark themes). */
  background?: string;
  /** Replacement mark color — same hue, darkened to clear 3:1 (light themes). */
  tint?: string;
}

function mixTowardBlack(hex: string, amount: number): string {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((c) =>
    Math.round(parseInt(c, 16) * (1 - amount))
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function resolveBrandChip(
  brandColor: string | undefined,
  scheme: AppColorScheme,
  userChosen?: boolean
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
  if (scheme.type === "dark") {
    // Mono brands like Goose and Open Interpreter render their official
    // silhouette against a near-white tile — preserving brand fidelity
    // rather than recoloring the mark. A user-chosen preset color is a
    // deliberate choice; render it as-is rather than stamping a white tile
    // that overrides their intent.
    if (userChosen) {
      return null;
    }
    if (contrastRatio(brandColor, CHIP_LIGHT) < NON_TEXT_CONTRAST_THRESHOLD) {
      return null;
    }
    return { background: CHIP_LIGHT };
  }
  // Light themes: a dark tile behind the mark reads as a black box stamped on
  // the pale chrome (the old behavior). Darken the mark itself instead — the
  // hue survives, no plate. Mixing toward black is monotonic against a
  // near-white panel, so the loop always terminates.
  for (let amount = 0.1; amount <= 0.9; amount += 0.1) {
    const candidate = mixTowardBlack(brandColor, amount);
    if (contrastRatio(candidate, surface) >= NON_TEXT_CONTRAST_THRESHOLD) {
      return { tint: candidate };
    }
  }
  return { tint: "#1F1F1F" };
}
