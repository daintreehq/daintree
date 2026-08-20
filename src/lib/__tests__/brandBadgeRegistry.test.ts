import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@shared/theme";
import { AGENT_REGISTRY } from "@shared/config/agentRegistry";
import { resolveBrandBadge } from "../brandIcon";

/**
 * The real-data gate for #11895. `brandIcon.test.ts` proves the resolver's math;
 * only this suite proves the shipped roster actually clears the floor, so a new
 * agent whose color happens to sit near the black/white crossover fails here
 * rather than in the UI.
 *
 * 4.5 rather than 1.4.11's 3.0: the marks render as small as 12px with thin
 * strokes, where a bare non-text pass still reads weakly. Black-or-white ink
 * guarantees ~4.58 for any opaque color, so the headroom is free.
 */
const BRAND_GLYPH_MIN_CONTRAST = 4.5;

const entries = Object.entries(AGENT_REGISTRY);

describe("brand badge contrast across the agent roster", () => {
  it("covers every registered agent", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s renders a badge whose glyph clears the floor", (_id, config) => {
    const badge = resolveBrandBadge(config.color);
    expect(badge).not.toBeNull();
    // The identity color reaches the screen exactly as authored — no darkening,
    // no damping, no polarity branch.
    expect(badge!.tile.toLowerCase()).toBe(config.color.toLowerCase());
    expect(contrastRatio(badge!.glyph, badge!.tile)).toBeGreaterThanOrEqual(
      BRAND_GLYPH_MIN_CONTRAST
    );
  });

  it("decides brand paint without consulting any theme surface", () => {
    // The architectural claim the issue turns on. Threading a surface back in is
    // the specific regression it names as a trap, and it would reintroduce the
    // bug silently — every ratio would still pass against whichever single
    // surface got picked. Read the source so the constraint outlives the
    // signature: an added `scheme` parameter would keep every other test green.
    const source = readFileSync(new URL("../brandIcon.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/surface-|scheme|Scheme|useActiveApp|getActiveTheme|\btokens\b/);
    // The only thing it may pull from the theme package is hex parsing; anything
    // else would be a route back to theme state under a different name.
    const themeImports = [...source.matchAll(/import \{([^}]*)\} from "@shared\/theme"/g)];
    expect(themeImports.flatMap((m) => m[1]!.split(",").map((n) => n.trim()))).toEqual([
      "isHexColor",
    ]);
  });
});
