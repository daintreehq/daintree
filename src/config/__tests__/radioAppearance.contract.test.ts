import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// #15361: Chromium paints an unchecked native radio as a filled grey disc on a
// dark colour scheme, so the host draws the radio itself. Under forced colours
// the UA-painted control is the only checked state that survives, so the
// drawing must never reach that mode. jsdom renders neither, so the cascade is
// pinned in the CSS source.

interface CssRule {
  prelude: string;
  /** The block's own declarations, with any nested blocks removed. */
  body: string;
  /** Enclosing preludes, outermost first. */
  context: string[];
}

// Strings are matched so they are skipped: the entry's `@source` globs end in a
// slash-star that would otherwise open a comment and swallow real rules.
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

function collectRules(css: string): CssRule[] {
  const src = css.replace(COMMENT_OR_STRING, (match) => (match.startsWith("/*") ? "" : match));
  const rules: CssRule[] = [];
  const stack: { prelude: string; bodyStart: number }[] = [];
  let preludeStart = 0;
  let quote: string | null = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      stack.push({ prelude: src.slice(preludeStart, i).trim(), bodyStart: i + 1 });
      preludeStart = i + 1;
    } else if (ch === "}") {
      const block = stack.pop();
      if (block) {
        let body = src.slice(block.bodyStart, i);
        while (/\{[^{}]*\}/.test(body)) body = body.replace(/[^;{}]*\{[^{}]*\}/g, "");
        rules.push({
          prelude: block.prelude.replace(/\s+/g, " "),
          body,
          context: stack.map((b) => b.prelude.replace(/\s+/g, " ")),
        });
      }
      preludeStart = i + 1;
    } else if (ch === ";") {
      preludeStart = i + 1;
    }
  }

  return rules;
}

function declaration(body: string, property: string): string | undefined {
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    if (part.slice(0, colon).trim() === property) return part.slice(colon + 1).trim();
  }
  return undefined;
}

const RADIO = /\[type=["']?radio["']?\]/;
const DRAWING =
  /(?:^|;)\s*(?:appearance|width|height|border(?:-[a-z-]+)?|background(?:-[a-z-]+)?)\s*:/;
const FORCED_COLORS_OFF =
  /^@media (?:\( ?forced-colors: ?none ?\)|not \( ?forced-colors: ?active ?\))$/;

const rules = collectRules(readIndexCss());
const radioRules = rules.filter((rule) => RADIO.test(rule.prelude));
const drawnRules = radioRules.filter((rule) =>
  rule.context.some((at) => FORCED_COLORS_OFF.test(at))
);

describe("radio appearance contract (#15361)", () => {
  it("draws the radio only while forced colours are off", () => {
    const drawn = radioRules.filter((rule) => declaration(rule.body, "appearance") === "none");
    expect(drawn.length).toBeGreaterThan(0);

    // A half-drawn radio under forced colours (a custom size or border with the
    // native control back, or the reverse) is as broken as a missing one.
    const offenders = radioRules
      .filter((rule) => DRAWING.test(rule.body))
      .filter((rule) => !rule.context.some((at) => FORCED_COLORS_OFF.test(at)))
      .map((rule) => `${rule.context.join(" > ")} > ${rule.prelude}`);
    expect(offenders).toEqual([]);
  });

  it("draws an empty ring at rest and adds a dot only when checked", () => {
    const resting = drawnRules.filter((rule) => !/:(?:checked|disabled)/.test(rule.prelude));
    const checked = drawnRules.filter((rule) => /:checked/.test(rule.prelude));
    expect(resting.length).toBeGreaterThan(0);
    expect(checked.length).toBeGreaterThan(0);

    const restingBorder = resting.map((rule) => declaration(rule.body, "border")).find(Boolean);
    expect(restingBorder).toBeDefined();
    expect(restingBorder).not.toMatch(/\b(?:none|transparent|0)\b/);

    for (const rule of resting) {
      const image = declaration(rule.body, "background-image");
      expect(image === undefined || image === "none").toBe(true);
    }

    const dot = checked.map((rule) => declaration(rule.body, "background-image")).find(Boolean);
    expect(dot).toBeDefined();
    expect(dot).not.toBe("none");
  });
});
