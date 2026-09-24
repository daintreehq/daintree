import { describe, expect, it } from "vitest";
import {
  COMPOSER_CONTROL_FOCUS_CLASS,
  COMPOSER_CONTROL_HOVER_BG_CLASS,
  COMPOSER_CONTROL_TEXT_CLASS,
} from "../composerControlStyles";

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

describe("composer control recipe", () => {
  it("leaves text colour out of the focus treatment, so a status colour survives focus", () => {
    expect(classes(COMPOSER_CONTROL_FOCUS_CLASS).filter((c) => c.includes(":text-"))).toEqual([]);
  });

  it("draws every colour from the shell's own palette, never the app ramp or accent", () => {
    const all = classes(
      [
        COMPOSER_CONTROL_TEXT_CLASS,
        COMPOSER_CONTROL_HOVER_BG_CLASS,
        COMPOSER_CONTROL_FOCUS_CLASS,
      ].join(" ")
    );
    const coloured = all.filter((c) => /(^|:)(text|bg|outline)-\[/.test(c));
    expect(coloured.length).toBeGreaterThan(0);
    for (const c of coloured) expect(c).toMatch(/var\(--ib-fg\)/);
    expect(all.filter((c) => /accent|text-text-|daintree-/.test(c))).toEqual([]);
  });
});
