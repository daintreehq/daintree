import { describe, expect, it } from "vitest";
import { readHostCss } from "@/__tests__/support/hostCss";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A loading skeleton painted in a colour its own background also uses is invisible, and
// invisibly so — it renders, it animates, and it shows nothing. That is what shipped:
// `--muted` is aliased to `--theme-surface-panel` and is never redefined by any theme,
// so `bg-muted` bones matched their background exactly on every panel surface in all 15
// themes, and on every dialog body in the 8 dark ones. The pulse animates opacity only,
// so it composites to the background at every frame and cannot rescue it.
//
// This guard asserts the RULE rather than the replacement colour: a skeleton's fill must
// not be a utility whose token is aliased to a surface. If someone later re-points
// `--muted` away from `--theme-surface-panel`, this test correctly stops objecting to it;
// if someone re-introduces any surface-aliased fill, it fails.
//
// KNOWN LIMITS (deliberate — a regression guard, not a sound checker):
//   - Only the shared `Skeleton.tsx` primitives are in scope. Hand-rolled bones
//     elsewhere (there are two) are not reached by a static read of this file.
//   - Alias resolution is one level deep against `src/index.css`, which is how these
//     tokens are actually declared. A multi-hop alias through a new indirection would
//     not be followed.

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const SKELETON = path.join(REPO_ROOT, "src/components/ui/Skeleton.tsx");

/** Every `--color-x: var(--y)` mapping declared in index.css. */
function colorAliases(css: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of css.matchAll(/--color-([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)) {
    aliases.set(match[1]!, match[2]!);
  }
  return aliases;
}

/** Every `--x: var(--theme-surface-…)` mapping — the bare tokens that ARE a surface. */
function surfaceAliasedTokens(css: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of css.matchAll(/^\s*--([a-z0-9-]+):\s*var\(--theme-surface-[a-z0-9-]+\)/gm)) {
    tokens.add(match[1]!);
  }
  return tokens;
}

/** The `bg-*` utilities the skeleton primitives actually paint. */
function skeletonBackgroundUtilities(source: string): string[] {
  return [...source.matchAll(/"bg-([a-z0-9-]+)(?:\/\[[^\]]+\])?\s/g)].map((m) => m[1]!);
}

describe("skeleton surface-collision contract", () => {
  // Both halves of the host CSS: the `--color-*: var(--…)` aliases this guard
  // resolves through moved into the design contract (#12220), and without them
  // `colorAliases` returns an empty map and a real collision goes unnoticed.
  const css = readHostCss();
  const source = fs.readFileSync(SKELETON, "utf8");

  it("the collision this guard exists for is still real", () => {
    // If this ever fails, `--muted` was re-pointed and the whole guard can be revisited.
    // Asserted so the rest of the file cannot quietly become vacuous.
    const surfaceTokens = surfaceAliasedTokens(css);
    expect(surfaceTokens.size).toBeGreaterThan(0);
    expect(surfaceTokens.has("muted")).toBe(true);
  });

  it("no skeleton fill resolves to a surface colour", () => {
    const aliases = colorAliases(css);
    const surfaceTokens = surfaceAliasedTokens(css);
    const utilities = skeletonBackgroundUtilities(source);

    expect(utilities.length).toBeGreaterThan(0);

    const collisions = utilities.filter((utility) => {
      const token = aliases.get(utility) ?? utility;
      return surfaceTokens.has(token) || token.startsWith("theme-surface-");
    });

    expect(
      collisions,
      `Skeleton.tsx paints ${collisions.join(", ")}, which resolve(s) to a surface colour — ` +
        `a bone the same colour as its own background renders nothing. Use a surface-relative ` +
        `alpha tint (bg-tint/[…]) instead.`
    ).toEqual([]);
  });

  it("the skeleton pulse cannot be the thing that makes a bone visible", () => {
    // `pulse-delayed` animates opacity between 0 and 1. Opacity on a fill that matches
    // its background composites to the background at every frame, so the animation is
    // never a substitute for a fill that contrasts. Pinned so a future "the pulse makes
    // it visible enough" argument has to contend with the keyframes.
    const block = css.slice(css.indexOf("@keyframes pulse-delayed"));
    const body = block.slice(0, block.indexOf("}\n}") + 3);
    expect(body).toMatch(/opacity/);
    expect(body).not.toMatch(/background|background-color/);
  });
});
