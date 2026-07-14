import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const CARD_PATH = resolve(__dirname, "../ProjectPulseCard.tsx");
const SUMMARY_PATH = resolve(__dirname, "../PulseSummary.tsx");
const HEATMAP_PATH = resolve(__dirname, "../PulseHeatmap.tsx");
const INDEX_CSS_PATH = resolve(__dirname, "../../../index.css");
const PULSE_CSS_PATH = resolve(__dirname, "../../../styles/components/pulse.css");
const FLAME_PATH = resolve(__dirname, "../StreakFlame.tsx");

// Find a `@media (X)` opening brace and return the slice up to the matching
// closing brace (or until the next top-level @media / @layer / @theme opens).
// Forbids rules being placed in the wrong block — the dual-block guard.
function mediaBlockSlice(content: string, mediaSelector: string): string {
  const start = content.indexOf(mediaSelector);
  if (start === -1) return "";
  const openBrace = content.indexOf("{", start);
  if (openBrace === -1) return "";
  let depth = 1;
  let i = openBrace + 1;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return content.slice(openBrace, i);
}

describe("ProjectPulseCard — visual contrast (issue #2645)", () => {
  it("card shell uses pulse component vars for per-theme shell styling", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('"pulse-card');
  });

  it("Activity icon does not use reduced-opacity status-success", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-status-success/70");
  });

  it("error and info state icons do not use reduced opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-status-error/70");
    expect(content).not.toContain("text-status-info/70");
  });

  it("primary title text uses at least /90 opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/90");
  });

  it("no card text uses /50 or /60 opacity (below secondary floor)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).not.toContain("text-daintree-text/50");
    expect(content).not.toContain("text-daintree-text/60");
  });

  it("coaching line uses at least /80 opacity", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/80");
  });

  it("coaching line does not use italic styling", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    const coachLineMatch = content.match(/getCoachLine\(.*?<\/p>/s);
    expect(coachLineMatch).toBeTruthy();
    const coachLineBlock = coachLineMatch![0];
    expect(coachLineBlock).not.toContain("italic");
  });

  it("button hover uses the pulse control hover component var", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('"pulse-control');
  });

  it("card header uses pulse-card-header class for per-theme header tinting", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('"pulse-card-header');
  });

  it("inline selector active item uses neutral selected tokens, not accent (issue #5979)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("bg-overlay-selected");
    expect(content).toContain("border-border-strong");
    expect(content).not.toContain(
      "color-mix(in oklab, var(--color-accent-primary) 12%, transparent)"
    );
    expect(content).not.toContain("border-daintree-accent/25");
    expect(content).not.toContain("text-daintree-accent");
  });
});

describe("PulseSummary — visual contrast (issue #2645)", () => {
  it("Stat non-highlight text uses /75 opacity (not /60)", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/75");
    expect(content).not.toContain("text-daintree-text/60");
  });

  it("Stat label uses /55 opacity floor (not /40)", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-daintree-text/55");
    expect(content).not.toContain("text-daintree-text/40");
  });

  it("delta row does not use opacity below the /55 tertiary floor", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).not.toContain("text-daintree-text/30");
    expect(content).not.toContain("text-daintree-text/40");
    expect(content).not.toContain("text-daintree-text/50");
  });

  it("delta insertions/deletions use at least /80 semantic colour", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    expect(content).toContain("text-status-success/80");
    expect(content).toContain("text-status-error/80");
  });
});

describe("PulseSummary — streak flame color fidelity (issue #9820)", () => {
  it("StreakFlame rows opt out of the opacity-70 dim so tier color renders at full strength", async () => {
    const content = await readFile(SUMMARY_PATH, "utf-8");
    // The `dim={false}` opt-out lives on the wrapping <Stat>, not the
    // <StreakFlame .../> child — match a windowed slice of each call site.
    const flameMatches = content.match(/<StreakFlame[\s\S]{0,400}?\n\s{10}\/>/g) ?? [];
    expect(flameMatches.length).toBe(2);
    for (const snippet of flameMatches) {
      expect(snippet).toContain("dim={false}");
      // And the dim class must not survive inside the flame Stat's window.
      expect(snippet).not.toContain("opacity-70");
    }
    // Symmetric guard: the cn(...) definition still applies opacity-70 to
    // the other neutral icons (GitCommit, Calendar, FilePenLine).
    expect(content).toContain("opacity-70");
  });
});

describe("PulseHeatmap — contrast on elevated card (issue #2645)", () => {
  it("heatmap uses square indicators and pulse component vars", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("rounded-[2px]");
    expect(content).toContain("var(--pulse-empty-bg");
  });

  it("most-recent-active ring uses the pulse ring offset token", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("var(--pulse-ring-offset");
    expect(content).not.toContain('cell.isToday && "ring-2');
  });
});

describe("PulseHeatmap — accent restraint (issue #7229)", () => {
  it("most-recent-active cell uses a neutral ring, not the accent token", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).not.toContain("ring-daintree-accent");
    expect(content).toContain("ring-daintree-text/25");
  });
});

describe("ProjectPulseCard — slot stability (issue #7671)", () => {
  it("skeleton, loaded, error, and new-repo variants share min-h-[240px] so swaps don't shift siblings", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    const occurrences = content.match(/min-h-\[240px\]/g);
    expect(occurrences).not.toBeNull();
    // PulseSkeleton + loaded card + new-repo variant + error variant = 4
    expect(occurrences!.length).toBeGreaterThanOrEqual(4);
  });

  it("health section wraps all four sub-variants in a single stable border-t pt-3 min-h-9 container", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    // The wrapping div holds the slot at a constant height while the loaded
    // health row, skeleton, no-remote hint, and offline hint swap inside it.
    expect(content).toContain('"border-t border-daintree-border pt-3 min-h-9"');
  });

  it("non-loaded variants centre content vertically inside the reserved slot", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    // `flex items-center` keeps the short message centred when min-h reserves
    // extra space (otherwise the message would pin to the top of the card).
    expect(content).toMatch(/min-h-\[240px\] flex items-center/);
  });
});

describe("ProjectPulseCard — accessibility (issue #7229)", () => {
  it("range selector uses radiogroup semantics with descriptive label", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('role="radiogroup"');
    expect(content).toContain('aria-label="Activity range"');
    expect(content).not.toContain('aria-label="Select pulse range"');
  });

  it("range buttons use role=radio + aria-checked, not aria-pressed", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('role="radio"');
    expect(content).toContain("aria-checked={isActive}");
    expect(content).not.toContain("aria-pressed={isActive}");
  });

  it("radiogroup uses roving tabindex (active=0, others=-1) and arrow-key handler", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("tabIndex={isActive ? 0 : -1}");
    expect(content).toContain("handleRangeKeyDown");
    expect(content).toContain("rangeButtonRefs");
    expect(content).toContain("ArrowRight");
    expect(content).toContain("ArrowLeft");
  });

  it("range buttons expose screen-reader-friendly labels", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("srLabel");
    expect(content).toContain('"60 days"');
    expect(content).toContain('"120 days"');
    expect(content).toContain('"180 days"');
  });

  it("card region surfaces aria-busy during background refresh", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("aria-busy={isLoading}");
  });

  it("includes a polite live region for refresh announcements", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('aria-live="polite"');
    expect(content).toContain('role="status"');
    expect(content).toContain("Refreshing pulse data");
    expect(content).toContain("Pulse data updated");
  });

  it("live-region completion is gated on a prior successful load and no error", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("hasEverLoadedRef");
    expect(content).toContain("!error");
  });

  it("refresh spinner respects motion-reduce", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("motion-reduce:animate-none");
  });
});

describe("PulseHeatmap — legend (issue #9819)", () => {
  it("ProjectPulseCard renders the legend testid", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('data-testid="pulse-heatmap-legend"');
  });

  it("legend spans the empty cell plus heat levels 1..4 (full Less→More range)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    // The legend iterates the empty (0) swatch and the four heat levels so
    // "Less" starts at no-commits, matching the GitHub contribution legend.
    expect(content).toContain("[0, 1, 2, 3, 4]");
    // Non-empty swatches carry their data-heat-level (forced-colors shape cue);
    // the empty swatch omits it, mirroring an empty cell.
    expect(content).toContain("data-heat-level={level > 0 ? level : undefined}");
    // Swatch fills route through the shared cell-background helper so the legend
    // tracks the same opacity ramp the grid uses (the bug fixed here: a flat,
    // full-strength legend on themes without opaque pulse-heat-1..4 stops).
    expect(content).toContain("getPulseHeatLevelBackground(level)");
  });

  it("per-level heat vars stay referenced so the drift scanner registers them", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    // Each per-level var is referenced explicitly (not via template literal) so
    // the EXTENSION_KEYS drift scanner registers all four consumers. After the
    // legend was routed through getPulseHeatLevelBackground, these live in the
    // heatmap module rather than the card.
    for (const level of [1, 2, 3, 4]) {
      expect(content).toContain(`var(--pulse-heat-${level},`);
    }
  });

  it("legend uses Less and More labels", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain(">Less<");
    expect(content).toContain(">More<");
  });

  it("legend is decorative (aria-hidden) and ships an sr-only description for aria-describedby", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain('aria-hidden="true"');
    expect(content).toContain("Heat intensity from no commits to many commits");
    expect(content).toContain("useId()");
    expect(content).toContain("describedBy=");
  });

  it("legend does NOT use the accent color (CLAUDE.md accent restraint)", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    // Strip the health-chip palette entry — it's a `tone: "accent"` chip on a
    // separate surface, not part of the legend chrome.
    const legendBlock = content.match(/function PulseHeatmapLegend[\s\S]*?^}/m);
    expect(legendBlock).toBeTruthy();
    expect(legendBlock![0]).not.toContain("text-accent-primary");
    expect(legendBlock![0]).not.toContain("var(--color-accent-primary)");
    expect(legendBlock![0]).not.toContain("ring-daintree-accent");
  });

  it("legend shares the heatmap row width via getPulseHeatmapRowWidth", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    expect(content).toContain("getPulseHeatmapRowWidth");
  });

  it("legend swatches reuse the pulse-heat-cell shape cue so they stay distinguishable in forced-colors", async () => {
    const content = await readFile(CARD_PATH, "utf-8");
    // Each swatch is a pulse-heat-cell with an inner shape span, so the
    // forced-colors size rules in src/index.css size the inner CanvasText
    // square per level — sighted WHCM users see the same 4-step cue on the
    // legend as on the grid itself.
    expect(content).toContain("pulse-heat-cell relative overflow-hidden");
    expect(content).toMatch(/pulse-heat-cell-shape/);
  });
});

describe("PulseHeatmap — high-contrast shape cue (issue #9819)", () => {
  it("PulseHeatmap tags non-empty cells with data-heat-level and a shape span", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    // Clamp to >=1 so a future renderer emitting (count > 0, level: 0) doesn't
    // produce a 0-sized CanvasText shape under forced-colors. The current
    // ProjectPulseService never emits this combination; the clamp is
    // defensive.
    expect(content).toContain("cell.count > 0 && cell.level > 0");
    expect(content).toContain("pulse-heat-cell-shape");
    expect(content).toContain('"pulse-heat-cell');
  });

  it("PulseHeatmap accepts a describedBy prop and applies aria-describedby", async () => {
    const content = await readFile(HEATMAP_PATH, "utf-8");
    expect(content).toContain("describedBy?: string");
    expect(content).toContain("aria-describedby={describedBy}");
  });

  it("pulse.css defines a hidden base rule for the shape (default off, forced-colors flips on)", async () => {
    const content = await readFile(PULSE_CSS_PATH, "utf-8");
    expect(content).toContain(".pulse-heat-cell-shape");
    expect(content).toMatch(/\.pulse-heat-cell-shape\s*{[^}]*display:\s*none/);
    expect(content).toMatch(/\.pulse-heat-cell-shape\s*{[^}]*position:\s*absolute/);
  });

  it("forced-colors block paints the shape with CanvasText and sizes it per level", async () => {
    const content = await readFile(INDEX_CSS_PATH, "utf-8");
    const block = mediaBlockSlice(content, "@media (forced-colors: active)");
    expect(block).toContain(".pulse-heat-cell-shape");
    expect(block).toContain("CanvasText");
    expect(block).toContain('.pulse-heat-cell[data-heat-level="1"] .pulse-heat-cell-shape');
    expect(block).toContain('.pulse-heat-cell[data-heat-level="2"] .pulse-heat-cell-shape');
    expect(block).toContain('.pulse-heat-cell[data-heat-level="3"] .pulse-heat-cell-shape');
    expect(block).toContain('.pulse-heat-cell[data-heat-level="4"] .pulse-heat-cell-shape');
  });

  it("forced-colors block borders the empty legend swatch so it stays visible", async () => {
    const content = await readFile(INDEX_CSS_PATH, "utf-8");
    const block = mediaBlockSlice(content, "@media (forced-colors: active)");
    // The level-0 legend swatch is a <span> (no button border) with no shape
    // span, so it needs an explicit border or it paints Canvas-on-Canvas.
    expect(block).toContain(
      '[data-testid="pulse-heatmap-legend"] .pulse-heat-cell:not([data-heat-level])'
    );
    expect(block).toMatch(
      /\[data-testid="pulse-heatmap-legend"\] \.pulse-heat-cell:not\(\[data-heat-level\]\)\s*{[^}]*border:\s*1px solid CanvasText/
    );
  });

  it("prefers-contrast block bumps heat-cell border to 1px theme-text", async () => {
    const content = await readFile(INDEX_CSS_PATH, "utf-8");
    const block = mediaBlockSlice(content, "@media (prefers-contrast: more)");
    expect(block).toContain(".pulse-heat-cell");
    expect(block).toMatch(/\.pulse-heat-cell\s*{[^}]*border-width:\s*1px/);
    expect(block).toContain("border-color: var(--color-daintree-text)");
  });

  it("the two contrast blocks stay separate (CLAUDE.md dual-block guard)", async () => {
    const content = await readFile(INDEX_CSS_PATH, "utf-8");
    const forcedStart = content.indexOf("@media (forced-colors: active)");
    const contrastStart = content.indexOf("@media (prefers-contrast: more)");
    expect(forcedStart).toBeGreaterThan(-1);
    expect(contrastStart).toBeGreaterThan(forcedStart);
    // The forced-colors block must close before the prefers-contrast block opens.
    const forcedBlock = mediaBlockSlice(content, "@media (forced-colors: active)");
    const forcedEnd = content.indexOf(forcedBlock) + forcedBlock.length;
    expect(forcedEnd).toBeLessThanOrEqual(contrastStart);
  });
});

describe("Pulse — no surface can express failure (issue #11172)", () => {
  const MISSED_DAY_SURFACE = /pulse-missed-bg|pulse-heat-cell-missed|pulse-heat-missed|Missed day/i;

  it.each([
    ["PulseHeatmap.tsx", HEATMAP_PATH],
    ["ProjectPulseCard.tsx", CARD_PATH],
    ["pulse.css", PULSE_CSS_PATH],
    ["index.css", INDEX_CSS_PATH],
  ])("%s carries no missed-day token, class, or label", async (_name, path) => {
    const content = await readFile(path, "utf-8");
    expect(content).not.toMatch(MISSED_DAY_SURFACE);
  });

  // The coach line's own vocabulary is held to a policy in
  // projectPulseCoach.test.ts, which checks every string the function can
  // actually return rather than grepping the source for quoted literals.

  it("streak flame colors are theme tokens, not hardcoded hexes", async () => {
    const content = await readFile(FLAME_PATH, "utf-8");
    // Each tier resolves through var(--pulse-streak-N, …) so a theme can
    // restyle it; the raw hex survives only as the inline fallback.
    expect(content).toMatch(/var\(--pulse-streak-1,/);
    expect(content).toMatch(/var\(--pulse-streak-7,/);
    expect(content).not.toMatch(/color:\s*"#[0-9A-Fa-f]{6}"/);
  });
});
