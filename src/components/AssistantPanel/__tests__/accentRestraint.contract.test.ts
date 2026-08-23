import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Accent restraint inside the assistant panel.
 *
 * The panel draws every colour from the TERMINAL theme, so its accent arrives as
 * `var(--assistant-accent)` — the terminal's own cursor colour. That makes it invisible
 * to the app-wide accent guard (src/config/__tests__/accentGuard.contract.test.ts),
 * which scans for `text-accent-primary` and its siblings. Without this file the panel
 * would simply have stopped being checked, which is the quiet way a rule dies.
 *
 * The rule (CLAUDE.md): accent is at most ONE load-bearing signal per focus region.
 * Never for multi-select, membership, secondary emphasis, or anything on several
 * elements at once.
 */

const DIR = path.resolve(__dirname, "..");

/**
 * Files allowed to paint accent as INK, with the reason.
 *
 * Focus rings are not listed and never need to be: an `outline-*` is the focus anchor,
 * which is the one accent use the rule exists to protect, and only one element can hold
 * focus at a time.
 */
const INK_ALLOWED = new Map([
  [
    "AssistantQuestionCard.tsx",
    "The question sheet's title. The sheet REPLACES the composer while a decision " +
      "blocks the turn, so the composer — the region's usual anchor — is not on screen " +
      "at the same time. The title is then the single load-bearing signal in the region.",
  ],
  [
    "AssistantMessage.tsx",
    "Link colour in rendered markdown. Not an emphasis signal: it is the convention " +
      "every renderer and every terminal uses for a hyperlink, and it appears only " +
      "where the model actually wrote one.",
  ],
]);

function sourceFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".css"));
}

/** Accent used as INK — colour, background or border — rather than as a focus ring. */
function accentInkUses(source: string): string[] {
  const hits: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.includes("--assistant-accent")) continue;
    // A focus ring is the sanctioned use and is excluded by construction.
    if (/outline-\[var\(--assistant-accent\)\]/.test(line)) continue;
    // The declaration itself, in the panel root's style object.
    if (line.includes('"--assistant-accent":')) continue;
    hits.push(line.trim().slice(0, 120));
  }
  return hits;
}

describe("assistant panel accent restraint", () => {
  it("paints accent as ink only where it is the region's one load-bearing signal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const uses = accentInkUses(readFileSync(path.join(DIR, file), "utf8"));
      if (uses.length === 0) continue;
      if (!INK_ALLOWED.has(file)) {
        offenders.push(`${file}: ${uses.join(" | ")}`);
      }
    }
    expect(
      offenders,
      `accent used as ink with no entry in INK_ALLOWED:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("has no stale entries in its own allowlist", () => {
    // The failure mode this mirrors from the app guard: an allowlist entry outlives the
    // code it excused, and the next accent added to that file is waved through.
    const stale = [...INK_ALLOWED.keys()].filter((file) => {
      let source: string;
      try {
        source = readFileSync(path.join(DIR, file), "utf8");
      } catch {
        return true; // File is gone.
      }
      return accentInkUses(source).length === 0;
    });
    expect(stale, `allowlist entries with nothing left to excuse: ${stale.join(", ")}`).toEqual([]);
  });

  it("keeps each allowed file to a SINGLE accent element", () => {
    // "One load-bearing signal" is a count, not a vibe. Two accented elements in one
    // file is two things competing to be the thing you look at.
    for (const file of INK_ALLOWED.keys()) {
      const uses = accentInkUses(readFileSync(path.join(DIR, file), "utf8"));
      expect(uses.length, `${file} paints accent on ${uses.length} elements`).toBeLessThanOrEqual(
        1
      );
    }
  });
});
