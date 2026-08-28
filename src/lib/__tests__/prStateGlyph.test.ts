import { describe, it, expect } from "vitest";
import { getPrStateColor, getPrStateGlyph } from "../prStateGlyph";
import type { NormalizedPRState } from "@shared/types/forge";

/**
 * The rule: a PR's state is never carried by colour alone (WCAG SC 1.4.1).
 * Two states that a reader must tell apart must differ in GLYPH as well as
 * hue — which is what these assert, rather than which glyph belongs to which
 * state. The glyph choices are a design decision and may move; that no two
 * meaningfully-different states collapse to the same mark may not.
 */
describe("PR state marks", () => {
  const STATES: NormalizedPRState[] = ["open", "merged", "closed", "declined"];

  it("gives every state a glyph and a colour", () => {
    for (const state of STATES) {
      expect(getPrStateGlyph(state), `${state} has no glyph`).toBeTruthy();
      expect(getPrStateColor(state), `${state} has no colour`).toMatch(/^text-pr-/);
    }
  });

  it("never distinguishes two states by colour alone", () => {
    // For every pair that differs in colour, the glyph must differ too.
    // `closed` and `declined` are the same state under two forge vocabularies,
    // so they are allowed — and required — to render identically.
    for (const a of STATES) {
      for (const b of STATES) {
        if (a === b) continue;
        const sameColour = getPrStateColor(a) === getPrStateColor(b);
        const sameGlyph = getPrStateGlyph(a) === getPrStateGlyph(b);
        if (!sameColour) {
          expect(sameGlyph, `${a} and ${b} differ only by colour`).toBe(false);
        } else {
          // Same colour ⇒ same state, so the glyph must agree.
          expect(sameGlyph, `${a} and ${b} share a colour but not a glyph`).toBe(true);
        }
      }
    }
  });

  it("treats `declined` as `closed` — one state, two forge spellings", () => {
    expect(getPrStateGlyph("declined")).toBe(getPrStateGlyph("closed"));
    expect(getPrStateColor("declined")).toBe(getPrStateColor("closed"));
  });

  it("reads an unresolved PR as open, matching what the badges did before", () => {
    expect(getPrStateGlyph(undefined)).toBe(getPrStateGlyph("open"));
    expect(getPrStateColor(undefined)).toBe(getPrStateColor("open"));
  });

  it("falls an unknown state through to closed, not to open", () => {
    // The safe direction: a stale or unrecognised state must not claim to be
    // an open PR someone can still push to.
    expect(getPrStateGlyph("something-new")).toBe(getPrStateGlyph("closed"));
    expect(getPrStateColor("something-new")).toBe(getPrStateColor("closed"));
  });

  it("marks an open draft apart from a plain open PR, in both glyph and colour", () => {
    expect(getPrStateGlyph("open", true)).not.toBe(getPrStateGlyph("open", false));
    expect(getPrStateColor("open", true)).not.toBe(getPrStateColor("open", false));
  });
});
