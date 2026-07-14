import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * ForgeStatsToolbarButton — freshness tier wiring (issue #6536, updated #8849).
 *
 * The parent wires freshness state into the three `ForgeStatPill` instances
 * via `ariaLabel` and `tooltipContent` (both populated from `freshnessSuffix`).
 * The in-pill clock glyph was removed in #8849 because it overflowed the
 * fixed-width pill container; freshness is now signalled solely through the
 * tooltip + aria-label copy.
 *
 * These are source assertions rather than render tests for the same reason as
 * `freshFetch`: the toolbar's eager dynamic-import effect resolves on a
 * microtask, and rendering it in jsdom triggers `EnvironmentTeardownError`s
 * when `import()` resolutions race the test-runner shutdown.
 */
const TOOLBAR_PATH = path.resolve(__dirname, "../ForgeStatsToolbarButton.tsx");

describe("ForgeStatsToolbarButton freshness wiring", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("imports freshness helpers from co-located FreshnessUtils", () => {
    expect(source).toContain('from "./FreshnessUtils"');
    expect(source).toContain("freshnessSuffix");
  });

  it("does not import or use freshnessOpacityClass or freshnessClass (issue #8180)", () => {
    // Opacity-as-stale reads as a disabled control on always-clickable pills
    // (WCAG 1.4.3/1.4.11/4.1.2). Staleness is carried by the freshnessSuffix
    // tooltip + aria-label copy instead (issue #8849 removed the in-pill glyph).
    expect(source).not.toContain("freshnessOpacityClass");
    expect(source).not.toContain("freshnessClass");
  });

  it("does not pass an in-pill freshness glyph (issue #8849)", () => {
    // The clock glyph overflowed the fixed-width pill container; freshness is
    // now signalled via tooltip + aria-label only.
    expect(source).not.toMatch(/freshnessGlyph=\{/);
    expect(source).not.toContain("FreshnessGlyph");
  });

  it("does not dim any pill className via freshness opacity (issue #8180)", () => {
    // The freshness signal moved off opacity entirely. The only remaining
    // opacity classes are the token-error disabled state (opacity-40) and the
    // zero-count de-emphasis (opacity-50) — both distinct from freshness.
    expect(source).not.toMatch(/freshnessOpacityClass\(commitFreshnessLevel\)/);
    expect(source).not.toMatch(/freshnessOpacityClass\(freshnessLevel\)/);
    // Guard the inline equivalents too — the freshness opacity tiers were
    // opacity-75 (aging) and opacity-60 (stale-disk); neither should reappear.
    expect(source).not.toContain("opacity-75");
    expect(source).not.toContain("opacity-60");
  });

  it("uses freshnessSuffix in ariaLabel and tooltipContent for freshness-aware copy", () => {
    // Commits uses commitFreshnessLevel; issues + PRs use freshnessLevel.
    const commitsMatch = source.match(/freshnessSuffix\(commitFreshnessLevel/g);
    const sharedMatch = source.match(/freshnessSuffix\(freshnessLevel/g);
    expect(commitsMatch).not.toBeNull();
    expect(commitsMatch?.length).toBe(2); // ariaLabel + tooltipContent
    expect(sharedMatch).not.toBeNull();
    expect(sharedMatch!.length).toBeGreaterThanOrEqual(4); // 2 issues + 2 PRs
  });

  it("applies animate-badge-bump via animKey prop on all three ForgeStatPill instances", () => {
    expect(source).toContain("animKey={issueAnimKey}");
    expect(source).toContain("animKey={prAnimKey}");
    expect(source).toContain("animKey={commitAnimKey}");
  });

  it("ForgeStatPill scopes the transition to opacity, background-color and scale (issue #11168)", async () => {
    // A bare `transition-opacity` here replaced the base Button cva's
    // `transition` outright under tailwind-merge (same conflict group), leaving
    // the hover tint AND the cva's `active:scale-[0.98]` press snap with no
    // transitioned property. `scale` must stay in the set for the press to read.
    const pillSource = await fs.readFile(path.resolve(__dirname, "../ForgeStatPill.tsx"), "utf-8");
    expect(pillSource).toContain("transition-[opacity,background-color,scale]");
    expect(pillSource).not.toMatch(/\btransition-all\b/);
  });

  it("ForgeStatPill opts into the reduced-motion rule that drops its press-scale", async () => {
    // The pill is a Radix tooltip trigger, so it always carries a data-state and
    // the global reduced-motion button rule in index.css (which excludes
    // data-state buttons) never reaches it. The opt-in is a two-file contract:
    // the class on the pill, the @variant rule in toolbar.css. WCAG 2.3.3.
    const pillSource = await fs.readFile(path.resolve(__dirname, "../ForgeStatPill.tsx"), "utf-8");
    const toolbarCss = await fs.readFile(
      path.resolve(__dirname, "../../../styles/components/toolbar.css"),
      "utf-8"
    );
    expect(pillSource).toContain("toolbar-stat-pill");
    expect(toolbarCss).toMatch(
      /@variant reduce-motion \{\s*\.toolbar-stat-pill \{\s*transition-property: opacity, background-color;/
    );
  });

  it("Stats pills use stable equal-width hit boxes for titlebar no-drag regions", async () => {
    const pillSource = await fs.readFile(path.resolve(__dirname, "../ForgeStatPill.tsx"), "utf-8");
    expect(pillSource).toContain("h-full flex-1 justify-center");
    expect(pillSource).toContain("min-w-[2ch] text-center");
    // The container width is dynamic — a 13rem budget for the three flex-1
    // pills (one third of it in commits-only mode, when no forge provider
    // resolves) plus a fixed slot per active trailing indicator — so the
    // pills keep stable equal widths without the old fixed-width +
    // overflow-hidden combo clipping (and disabling hover on) the indicators.
    expect(source).toContain("flex h-8 shrink-0 items-center");
    expect(source).toContain("width: statsContainerWidth");
    expect(source).toContain("forgeMode ? 13 : 13 / 3");
    expect(source).toContain("calc(${statsBaseWidthRem}rem +");
    // Counts wider than the per-pill character budget grow every pill share
    // by the same overflow — equal widths are preserved by widening the
    // shared budget, not by letting one pill clip (5-digit commit counts
    // overflowed the commits-only pill).
    expect(source).toContain("pillOverflowChars");
    expect(source).toMatch(/maxOverflowChars\s*\*\s*PILL_EXTRA_CHAR_REM/);
  });

  it("parent className props do not introduce transition-all", () => {
    expect(source).not.toMatch(/transition-all/);
  });

  it("derives the tooltip aging copy from useGlobalMinuteTicker, not a per-component setInterval", () => {
    expect(source).toContain('from "@/hooks/useGlobalMinuteTicker"');
    expect(source).toMatch(/const\s+tick\s*=\s*useGlobalMinuteTicker\(\)/);
    expect(source).toMatch(/useMemo\(\s*\(\)\s*=>\s*\{[\s\S]*?Date\.now\(\)/);
  });

  it("derives commitFreshnessLevel that maps errored to fresh for the commits pill", () => {
    // Commits are from git, not GitHub — GitHub connectivity errors shouldn't
    // degrade the commits pill.
    expect(source).toContain("commitFreshnessLevel");
    expect(source).toMatch(
      /commitFreshnessLevel\s*=\s*freshnessLevel\s*===\s*"errored"\s*\?\s*"fresh"\s*:\s*freshnessLevel/
    );
  });

  it("only bumps animation keys when the displayed count actually changes", () => {
    expect(source).toContain("issueCountRef.current === undefined");
    expect(source).toContain("prCountRef.current === undefined");
    expect(source).toContain("commitCountRef.current === undefined");
    expect(source).toMatch(/issueCountRef\.current\s*!==\s*issueCount/);
    expect(source).toMatch(/prCountRef\.current\s*!==\s*prCount/);
    expect(source).toMatch(/commitCountRef\.current\s*!==\s*commitCount/);
  });
});
