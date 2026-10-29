import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// #15361: Chromium paints an unchecked native radio as a filled grey disc on a
// dark colour scheme, so the host draws the radio itself. Under forced colours
// the UA-painted control is the only checked state that survives, so the
// drawing must never reach that mode. jsdom renders neither, so the cascade is
// pinned in the CSS source.

interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

interface CssRule {
  prelude: string;
  /** The block's own declarations in source order, nested blocks excluded. */
  declarations: Declaration[];
  /** Enclosing preludes, outermost first. */
  context: string[];
}

// Strings are matched so they are skipped: the entry's `@source` globs end in a
// slash-star that would otherwise open a comment and swallow real rules.
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

const squash = (text: string) => text.trim().replace(/\s+/g, " ");

/** Splits on a separator outside strings and parentheses. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && separator.test(ch)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseDeclarations(text: string): Declaration[] {
  return splitTopLevel(text, /;/).flatMap((part) => {
    const colon = part.indexOf(":");
    if (colon <= 0) return [];
    const raw = squash(part.slice(colon + 1));
    const value = raw.replace(/\s*!important$/i, "");
    return [
      { property: part.slice(0, colon).trim().toLowerCase(), value, important: value !== raw },
    ];
  });
}

function collectRules(css: string): CssRule[] {
  const src = css.replace(COMMENT_OR_STRING, (match) => (match.startsWith("/*") ? "" : match));
  const rules: (CssRule & { opened: number })[] = [];
  // `own` gathers a block's text outside its children; `cursor` is where the
  // next stretch of it starts, just past the last child to close.
  const stack: { prelude: string; own: string; cursor: number; opened: number }[] = [];
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
      const parent = stack.at(-1);
      if (parent) parent.own += src.slice(parent.cursor, preludeStart);
      stack.push({
        prelude: squash(src.slice(preludeStart, i)),
        own: "",
        cursor: i + 1,
        opened: i,
      });
      preludeStart = i + 1;
    } else if (ch === "}") {
      const block = stack.pop();
      if (block) {
        block.own += src.slice(block.cursor, i);
        rules.push({
          prelude: block.prelude,
          declarations: parseDeclarations(block.own),
          context: stack.map((b) => b.prelude),
          opened: block.opened,
        });
      }
      const parent = stack.at(-1);
      if (parent) parent.cursor = i + 1;
      preludeStart = i + 1;
    } else if (ch === ";") {
      preludeStart = i + 1;
    }
  }

  // Blocks close child-first; the cascade reads them in the order they open.
  return rules.sort((a, b) => a.opened - b.opened);
}

/** True only for a media query no forced-colours-active environment can match. */
function excludesForcedColors(at: string): boolean {
  const query = /^@media (.*)$/.exec(at)?.[1];
  if (!query || /,|\bor\b/.test(query)) return false;
  if (/^not \( ?forced-colors ?: ?active ?\)$/.test(query)) return true;
  return (
    !/^not\b|\bnot \(+ ?forced-colors/.test(query) && /\( ?forced-colors ?: ?none ?\)/.test(query)
  );
}

/**
 * Whether a selector applies to a radio at rest (`checked` false) or chosen. A
 * transient state (hover, focus, disabled) is neither.
 */
function appliesTo(selector: string, checked: boolean): boolean {
  const positive = selector.replace(/:not\([^)]*\)/g, "");
  if (/:(?:hover|focus|active|disabled|indeterminate)\b/.test(positive)) return false;
  if (/:checked/.test(positive)) return checked;
  if (/:not\([^)]*:checked[^)]*\)/.test(selector)) return !checked;
  return true;
}

/** A rule's radio selectors, each led by its enclosing style rules so nesting resolves. */
function radioSelectors(rule: CssRule): string[] {
  const levels = [...rule.context.filter((at) => !at.startsWith("@")), rule.prelude];
  return levels
    .map((prelude) => splitTopLevel(prelude, /,/))
    .reduce(
      (paths, alternatives) => paths.flatMap((path) => alternatives.map((s) => `${path} ${s}`)),
      [""]
    )
    .map((selector) => selector.trim())
    .filter((selector) => RADIO.test(selector));
}

interface Paint {
  borderWidth: string;
  borderStyle: string;
  borderColor: string;
  image: string;
}

const BORDER_STYLES = /^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/;
const BORDER_WIDTHS = /^(?:thin|medium|thick|-?[\d.]+[a-z%]*)$/;
const VISIBLE_WIDTH = /^(?:thin|medium|thick|(?=[\d.]*[1-9])\d*\.?\d+[a-z]+)$/;

/** The border and background image a state ends with, folding its rules in source order. */
function resolvePaint(rules: CssRule[]): Paint {
  const paint: Paint = {
    borderWidth: "medium",
    borderStyle: "none",
    borderColor: "currentcolor",
    image: "none",
  };
  const locked = new Set<keyof Paint>();
  for (const { property, value, important } of rules.flatMap((rule) => rule.declarations)) {
    const set = (field: keyof Paint, next: string) => {
      if (locked.has(field) && !important) return;
      paint[field] = next;
      if (important) locked.add(field);
    };
    if (property === "border") {
      const tokens = splitTopLevel(value, /\s/);
      set("borderWidth", tokens.find((t) => BORDER_WIDTHS.test(t)) ?? "medium");
      set("borderStyle", tokens.find((t) => BORDER_STYLES.test(t)) ?? "none");
      set(
        "borderColor",
        tokens.find((t) => !BORDER_WIDTHS.test(t) && !BORDER_STYLES.test(t)) ?? "currentcolor"
      );
    } else if (property === "border-width") set("borderWidth", value);
    else if (property === "border-style") set("borderStyle", value);
    else if (property === "border-color") set("borderColor", value);
    // The shorthand resets the image when it names none, so it counts as a write.
    else if (property === "background" || property === "background-image") set("image", value);
  }
  return paint;
}

const hasRing = (paint: Paint) =>
  !/^(?:none|hidden)$/.test(paint.borderStyle) &&
  VISIBLE_WIDTH.test(paint.borderWidth) &&
  paint.borderColor !== "transparent";

const hasImage = (paint: Paint) =>
  /(?:gradient|url|image-set|cross-fade|element)\(/.test(paint.image);

const RADIO = /\[type=["']?radio["']?\]/;
const DRAWING = /^(?:appearance|width|height|border(?:-[a-z-]+)?|background(?:-[a-z-]+)?)$/;

const rules = collectRules(readIndexCss());
const radioRules = rules.filter((rule) => radioSelectors(rule).length > 0);
const drawnRules = radioRules.filter((rule) => rule.context.some(excludesForcedColors));

describe("radio appearance contract (#15361)", () => {
  it("draws the radio only while forced colours are off", () => {
    const drawn = radioRules.filter((rule) =>
      rule.declarations.some((d) => d.property === "appearance" && d.value === "none")
    );
    expect(drawn.length).toBeGreaterThan(0);

    // A half-drawn radio under forced colours (a custom size or border with the
    // native control back, or the reverse) is as broken as a missing one.
    const offenders = radioRules
      .filter((rule) => rule.declarations.some((d) => DRAWING.test(d.property)))
      .filter((rule) => !rule.context.some(excludesForcedColors))
      .map((rule) => `${rule.context.join(" > ")} > ${rule.prelude}`);
    expect(offenders).toEqual([]);
  });

  it("draws an empty ring at rest and adds a dot only when checked", () => {
    const inState = (checked: boolean) =>
      drawnRules.filter((rule) => radioSelectors(rule).some((s) => appliesTo(s, checked)));
    const resting = resolvePaint(inState(false));
    const checked = resolvePaint(inState(true));

    expect(hasRing(resting)).toBe(true);
    expect(hasImage(resting)).toBe(false);
    expect(hasRing(checked)).toBe(true);
    expect(hasImage(checked)).toBe(true);
  });
});
