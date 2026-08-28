import { describe, it, expect } from "vitest";
import {
  ROLE_ORDER,
  bandFor,
  branchesCoexist,
  isCompositingOpacity,
  isDisabledVariant,
  isPlaceholderVariant,
  isStateVariant,
  promote,
  replacementToken,
  roleClass,
} from "./theme-text-ramp.js";

/**
 * The bands are only defensible against the numbers `theme:text-contrast` prints,
 * so what is worth testing is the shape of the partition rather than which role
 * each step got: no step in two bands, no step in none, and `text-muted` — whose
 * floor is 2.2:1 on namib's elevated panel, below the `/50` step it looks like it
 * should absorb — never a destination.
 */
describe("band partition", () => {
  const STEPS = [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];

  it("assigns every ramp step but /40 exactly one role", () => {
    const unassigned = STEPS.filter((step) => bandFor(step) === null);
    expect(unassigned, "#12003 ruled on /40 site by site; every other step needs a band").toEqual([
      40,
    ]);
  });

  it("never sends a step to text-muted", () => {
    expect(STEPS.map(bandFor).filter((role) => role === "muted")).toEqual([]);
  });

  it("orders the bands monotonically, so a brighter step never lands on a dimmer role", () => {
    const ranked = STEPS.filter((step) => step !== 40).map((step) => ({
      step,
      rank: ROLE_ORDER.indexOf(bandFor(step)!),
    }));
    for (let i = 1; i < ranked.length; i++) {
      expect(
        ranked[i]!.rank,
        `/${ranked[i]!.step} must not rank below /${ranked[i - 1]!.step}`
      ).toBeGreaterThanOrEqual(ranked[i - 1]!.rank);
    }
  });
});

describe("promotion", () => {
  it("moves a role one step brighter", () => {
    expect(promote("placeholder")).toBe("secondary");
    expect(promote("secondary")).toBe("primary");
  });

  it("saturates at primary rather than running off the end", () => {
    expect(promote("primary")).toBe("primary");
  });

  it("never lowers a contrast floor", () => {
    for (const role of ROLE_ORDER) {
      expect(ROLE_ORDER.indexOf(promote(role))).toBeGreaterThanOrEqual(ROLE_ORDER.indexOf(role));
    }
  });
});

describe("token rewriting", () => {
  it("keeps the variant chain and drops only the alpha", () => {
    expect(replacementToken("hover:", "primary")).toBe("hover:text-text-primary");
    expect(replacementToken("group-hover/stagerow:", "secondary")).toBe(
      "group-hover/stagerow:text-text-secondary"
    );
    expect(replacementToken("", "placeholder")).toBe("text-text-placeholder");
  });

  it("spells the role the way Tailwind resolves it", () => {
    expect(roleClass("secondary")).toBe(`text-text-secondary`);
  });
});

describe("variant classification", () => {
  it("reads a state variant anywhere in the chain", () => {
    expect(isStateVariant("hover:")).toBe(true);
    expect(isStateVariant("group-hover/baserow:")).toBe(true);
    expect(isStateVariant("group-aria-selected:")).toBe(true);
    expect(isStateVariant("md:hover:")).toBe(true);
  });

  it("does not mistake a breakpoint or container query for a state", () => {
    expect(isStateVariant("md:")).toBe(false);
    expect(isStateVariant("@max-[280px]/empty-state:")).toBe(false);
    expect(isStateVariant("")).toBe(false);
  });

  it("recognises disabled in both the plain and aria spellings", () => {
    expect(isDisabledVariant("disabled:")).toBe(true);
    expect(isDisabledVariant("aria-disabled:hover:")).toBe(true);
    expect(isDisabledVariant("group-disabled:")).toBe(true);
    expect(isDisabledVariant("hover:")).toBe(false);
  });

  it("treats disabled:hover: as disabled — a control that cannot be used has no affordance", () => {
    expect(isDisabledVariant("disabled:hover:")).toBe(true);
    expect(isStateVariant("disabled:hover:")).toBe(true);
  });

  it("spots the placeholder variant without matching a placeholder colour utility", () => {
    expect(isPlaceholderVariant("placeholder:")).toBe(true);
    expect(isPlaceholderVariant("hover:")).toBe(false);
  });
});

describe("compositing opacity", () => {
  it("counts an unconditional partial opacity", () => {
    expect(isCompositingOpacity("opacity-50")).toBe(true);
    expect(isCompositingOpacity("opacity-40")).toBe(true);
  });

  it("ignores a variant-prefixed opacity, whose resting composite is still 1", () => {
    expect(isCompositingOpacity("hover:opacity-100")).toBe(false);
    expect(isCompositingOpacity("disabled:opacity-50")).toBe(false);
    expect(isCompositingOpacity("group-hover:opacity-50")).toBe(false);
  });

  it("ignores the reveal idiom at both ends", () => {
    expect(isCompositingOpacity("opacity-0")).toBe(false);
    expect(isCompositingOpacity("opacity-100")).toBe(false);
  });

  it("ignores utilities that merely start the same way", () => {
    expect(isCompositingOpacity("opacity-[var(--x)]")).toBe(false);
    expect(isCompositingOpacity("bg-opacity-50")).toBe(false);
  });
});

/**
 * Branch paths run outer to inner, so coexistence is a prefix test. This is what
 * stops a resting colour in one ternary arm pairing with a hover colour in the
 * other — the pairing that would report a false inversion — while still letting
 * an unconditional `hover:` reach the resting colour in every arm.
 */
describe("branch coexistence", () => {
  it("pairs tokens on the same path", () => {
    expect(branchesCoexist("12T", "12T")).toBe(true);
  });

  it("pairs an unconditional token with every branch", () => {
    expect(branchesCoexist("", "12T/44F")).toBe(true);
    expect(branchesCoexist("12T/44F", "")).toBe(true);
  });

  it("pairs an outer branch with a branch nested inside it", () => {
    expect(branchesCoexist("12T", "12T/44F")).toBe(true);
  });

  it("keeps sibling branches apart", () => {
    expect(branchesCoexist("12T", "12F")).toBe(false);
    expect(branchesCoexist("12T/44F", "12T/44T")).toBe(false);
  });

  it("does not treat a shared prefix inside one segment as nesting", () => {
    expect(branchesCoexist("12T", "120T")).toBe(false);
  });
});
