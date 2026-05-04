import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * GitHubStatsToolbarButton — freshness tier wiring (issue #6536).
 *
 * After extracting `freshnessOpacityClass`, `FreshnessGlyph`, `formatTimeSince`,
 * and `freshnessSuffix` to `FreshnessUtils.tsx`, the parent still wires these
 * into the three `GitHubStatPill` instances via the `className`, `freshnessGlyph`,
 * `ariaLabel`, and `tooltipContent` props.
 *
 * These are source assertions rather than render tests for the same reason as
 * `freshFetch`: the toolbar's eager dynamic-import effect resolves on a
 * microtask, and rendering it in jsdom triggers `EnvironmentTeardownError`s
 * when `import()` resolutions race the test-runner shutdown.
 */
const TOOLBAR_PATH = path.resolve(__dirname, "../GitHubStatsToolbarButton.tsx");

describe("GitHubStatsToolbarButton freshness wiring", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("imports freshness helpers from co-located FreshnessUtils", () => {
    expect(source).toContain('from "./FreshnessUtils"');
    expect(source).toContain("freshnessOpacityClass");
    expect(source).toContain("FreshnessGlyph");
    expect(source).toContain("freshnessSuffix");
  });

  it("passes FreshnessGlyph to all three GitHubStatPill instances", () => {
    const glyphs = source.match(/freshnessGlyph=\{/g);
    expect(glyphs).not.toBeNull();
    expect(glyphs?.length).toBe(3);
  });

  it("uses freshnessOpacityClass in className for all three pills", () => {
    const matches = source.match(/freshnessOpacityClass\(freshnessLevel\)/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(3);
  });

  it("uses freshnessSuffix in ariaLabel and tooltipContent for freshness-aware copy", () => {
    const matches = source.match(/freshnessSuffix\(freshnessLevel/g);
    expect(matches).not.toBeNull();
    // At least 3 (ariaLabel) + 3 (tooltipContent) = 6 occurrences
    expect(matches!.length).toBeGreaterThanOrEqual(6);
  });

  it("applies animate-badge-bump via animKey prop on all three GitHubStatPill instances", () => {
    expect(source).toContain("animKey={issueAnimKey}");
    expect(source).toContain("animKey={prAnimKey}");
    expect(source).toContain("animKey={commitAnimKey}");
  });

  it("GitHubStatPill uses scoped transition-opacity, not transition-all", async () => {
    const pillSource = await fs.readFile(path.resolve(__dirname, "../GitHubStatPill.tsx"), "utf-8");
    expect(pillSource).toContain("transition-opacity");
    expect(pillSource).not.toMatch(/\btransition-all\b/);
  });

  it("parent className props do not introduce transition-all", () => {
    expect(source).not.toMatch(/transition-all/);
  });

  it("derives the tooltip aging copy from useGlobalMinuteTicker, not a per-component setInterval", () => {
    expect(source).toContain('from "@/hooks/useGlobalMinuteTicker"');
    expect(source).toMatch(/const\s+tick\s*=\s*useGlobalMinuteTicker\(\)/);
    expect(source).toMatch(/useMemo\(\s*\(\)\s*=>\s*\{[\s\S]*?Date\.now\(\)/);
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
