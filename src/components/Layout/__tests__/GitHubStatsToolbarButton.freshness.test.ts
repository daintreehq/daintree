import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * GitHubStatsToolbarButton — freshness tier wiring (issue #6536).
 *
 * Replaces the binary `isStale` opacity-60 tint with a four-tier
 * `FreshnessLevel` (`fresh` / `aging` / `stale-disk` / `errored`) sourced from
 * `useRepositoryStats`. Each non-fresh tier pairs an opacity step with a
 * spatial glyph and freshness-aware tooltip / aria-label copy so the user can
 * distinguish a 30-second-old poll from disk-cached data from a network
 * failure.
 *
 * These are source assertions rather than render tests for the same reason as
 * `freshFetch`: the toolbar's eager dynamic-import effect resolves on a
 * microtask, and rendering it in jsdom triggers `EnvironmentTeardownError`s
 * when `import()` resolutions race the test-runner shutdown. The hook's tier
 * computation itself is exercised in `useRepositoryStats.test.tsx`.
 */
const TOOLBAR_PATH = path.resolve(__dirname, "../GitHubStatsToolbarButton.tsx");

describe("GitHubStatsToolbarButton freshness wiring", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(TOOLBAR_PATH, "utf-8");
  });

  it("imports FreshnessLevel from useRepositoryStats and consumes freshnessLevel", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*useRepositoryStats[^}]*type\s+FreshnessLevel[^}]*\}\s*from\s*"@\/hooks\/useRepositoryStats"/
    );
    expect(source).toContain("freshnessLevel,");
    expect(source).toMatch(/\}\s*=\s*useRepositoryStats\(\)/);
  });

  it("imports the Clock and WifiOff lucide icons used by FreshnessGlyph", () => {
    expect(source).toMatch(/from\s*"lucide-react".*Clock/s);
    expect(source).toMatch(/from\s*"lucide-react".*WifiOff/s);
  });

  it("declares a tier-driven opacity helper covering all four levels", () => {
    expect(source).toContain("function freshnessOpacityClass(level: FreshnessLevel)");
    const helperStart = source.indexOf("function freshnessOpacityClass");
    const helperBody = source.slice(helperStart, helperStart + 600);
    expect(helperBody).toContain('case "aging"');
    expect(helperBody).toContain('case "stale-disk"');
    expect(helperBody).toContain('case "errored"');
  });

  it("renders FreshnessGlyph alongside each numeral span", () => {
    const glyphs = source.match(/<FreshnessGlyph level=\{freshnessLevel\}/g);
    expect(glyphs).not.toBeNull();
    // Issues, PRs, and Commits all render the glyph (commits unconditionally
    // because there's no isTokenError gating for the commit pill).
    expect(glyphs?.length).toBe(3);
  });

  it("never reaches for the accent color in any freshness state", () => {
    const helperStart = source.indexOf("function freshnessOpacityClass");
    const glyphStart = source.indexOf("function FreshnessGlyph");
    const suffixStart = source.indexOf("function freshnessSuffix");
    expect(helperStart).toBeGreaterThan(0);
    expect(glyphStart).toBeGreaterThan(0);
    expect(suffixStart).toBeGreaterThan(0);
    const tierBlock =
      source.slice(helperStart, helperStart + 700) +
      source.slice(glyphStart, glyphStart + 700) +
      source.slice(suffixStart, suffixStart + 700);
    expect(tierBlock).not.toMatch(/accent-primary|text-accent|outline-daintree-accent/);
  });

  it("applies animate-badge-bump and a per-count key to all three numeral spans", () => {
    // Three count numerals (issues, PRs, commits) each get the keyframe class.
    const animMatches = source.match(/animate-badge-bump/g);
    expect(animMatches).not.toBeNull();
    // 1 in CSS-class definition (none here, defined in index.css) + 3 numerals
    expect(animMatches?.length).toBe(3);

    expect(source).toContain("key={issueAnimKey}");
    expect(source).toContain("key={prAnimKey}");
    expect(source).toContain("key={commitAnimKey}");
  });

  it("scopes opacity transitions explicitly (not bare `transition` or `transition-all`)", () => {
    // Anchor on the toolbar-pill button signature `h-full gap-2 rounded-none`
    // which is unique to the three stats buttons. An optional leading
    // `relative ` is allowed so absolute-positioned chips (issues + PRs
    // corner activity chip) can be anchored without breaking this regex.
    const tooltipBlocks = source.match(
      /className=\{cn\(\s*"(?:relative\s+)?h-full gap-2 rounded-none[\s\S]*?\)\s*\}/g
    );
    expect(tooltipBlocks).not.toBeNull();
    expect(tooltipBlocks?.length).toBe(3);
    for (const block of tooltipBlocks ?? []) {
      expect(block).toContain("transition-opacity");
      expect(block).not.toMatch(/\btransition-all\b/);
      expect(block).not.toMatch(/"\s*transition\s*"/);
    }
  });

  it("derives the tooltip aging copy from useGlobalMinuteTicker, not a per-component setInterval", () => {
    expect(source).toContain('from "@/hooks/useGlobalMinuteTicker"');
    expect(source).toMatch(/const\s+tick\s*=\s*useGlobalMinuteTicker\(\)/);
    expect(source).toMatch(/useMemo\(\s*\(\)\s*=>\s*\{[\s\S]*?Date\.now\(\)/);
  });

  it("only bumps animation keys when the displayed count actually changes", () => {
    // The effect must guard against the initial mount (undefined sentinel)
    // so a cold launch doesn't pulse every count, and must compare against
    // the last applied value so a no-op poll doesn't re-trigger.
    expect(source).toContain("issueCountRef.current === undefined");
    expect(source).toContain("prCountRef.current === undefined");
    expect(source).toContain("commitCountRef.current === undefined");
    expect(source).toMatch(/issueCountRef\.current\s*!==\s*issueCount/);
    expect(source).toMatch(/prCountRef\.current\s*!==\s*prCount/);
    expect(source).toMatch(/commitCountRef\.current\s*!==\s*commitCount/);
  });
});
