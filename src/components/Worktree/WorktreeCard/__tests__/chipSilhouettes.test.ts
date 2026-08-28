import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * The card's corner status mark must not carry its meaning in colour alone
 * (WCAG SC 1.4.1). It is the only place on the card where `cleanup` and
 * `complete` are told apart at all, so if their fills were the whole
 * difference, nothing on screen would distinguish them for a reader who cannot
 * separate those two hues.
 *
 * These assert the RULE — every state has its own hue AND its own silhouette,
 * and the two maps stay exhaustive together — not which polygon belongs to
 * which state. The shapes are a design decision and will move; that each state
 * is distinguishable without colour is not.
 */
const cardSource = readFileSync(resolve(__dirname, "../../WorktreeCard.tsx"), "utf-8");

/** Pull a `Record<..., string>` object literal's key/value pairs out of source. */
function readStringRecord(name: string): Record<string, string> {
  const start = cardSource.indexOf(`const ${name}`);
  expect(start, `${name} not found in WorktreeCard.tsx`).toBeGreaterThan(-1);
  const open = cardSource.indexOf("{", start);
  const close = cardSource.indexOf("};", open);
  const body = cardSource.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) {
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** The `chipState === "x" && "bg-y"` fill branches on the mark itself. */
function readChipFills(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of cardSource.matchAll(/chipState === "(\w+)" && "(bg-[\w-]+)"/g)) {
    const [, state, token] = match;
    if (state === undefined || token === undefined) continue;
    out[state] = token;
  }
  return out;
}

describe("worktree card corner status mark", () => {
  const clips = readStringRecord("CHIP_CLIP_PATHS");
  const labels = readStringRecord("CHIP_LABELS");
  const fills = readChipFills();

  it("defines a silhouette, a fill and a label for every state, with no state missing from any", () => {
    const states = Object.keys(labels);
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(clips).sort()).toEqual(states.slice().sort());
    expect(Object.keys(fills).sort()).toEqual(states.slice().sort());
  });

  it("gives no two states the same silhouette", () => {
    const shapes = Object.values(clips);
    expect(new Set(shapes).size, `duplicate clip-path across states: ${shapes.join(" | ")}`).toBe(
      shapes.length
    );
  });

  it("gives no two states the same fill, so shape and colour agree rather than substitute", () => {
    const tokens = Object.values(fills);
    expect(new Set(tokens).size, `duplicate fill across states: ${tokens.join(" | ")}`).toBe(
      tokens.length
    );
  });

  it("renders the silhouette from the map rather than a literal, so a new state cannot inherit one", () => {
    // A hardcoded `clipPath: "polygon(...)"` on the mark would make every state
    // the same shape again the moment someone added a fourth.
    const markBlock = cardSource.slice(
      cardSource.indexOf('"status-mark absolute'),
      cardSource.indexOf("aria-label={CHIP_LABELS[chipState]}")
    );
    expect(markBlock).toContain("clipPath: CHIP_CLIP_PATHS[chipState]");
    expect(markBlock).not.toMatch(/clipPath:\s*"/);
  });

  it("keeps every silhouette anchored to the corner the mark is positioned in", () => {
    // The grid variant rounds this corner (`rounded-tl-lg`), so a shape that
    // hugs the top or left edge instead of the corner is clipped away there and
    // survives only in the sidebar — which would put the two variants on
    // different vocabularies again.
    for (const [state, clip] of Object.entries(clips)) {
      expect(clip, `${state} is not a polygon`).toMatch(/^polygon\(/);
      const points = clip
        .replace(/^polygon\(|\)$/g, "")
        .split(",")
        .map((p) =>
          p
            .trim()
            .split(/\s+/)
            .map((n) => parseFloat(n))
        );
      // Every vertex inside the box, and at least one on each of the two axes
      // that meet at the origin — that is what makes it a corner wedge.
      for (const [x, y] of points) {
        expect(x, `${state}: x out of the mark's box`).toBeGreaterThanOrEqual(0);
        expect(x, `${state}: x out of the mark's box`).toBeLessThanOrEqual(100);
        expect(y, `${state}: y out of the mark's box`).toBeGreaterThanOrEqual(0);
        expect(y, `${state}: y out of the mark's box`).toBeLessThanOrEqual(100);
      }
      expect(
        points.some(([x]) => x === 0),
        `${state} does not touch the left edge`
      ).toBe(true);
      expect(
        points.some(([, y]) => y === 0),
        `${state} does not touch the top edge`
      ).toBe(true);
    }
  });
});
