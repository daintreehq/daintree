import { expressionEnd, matchClose, splitArgs, type ScannedSource } from "./source.js";
import type { ClassToken, JsxElement } from "./types.js";

const CLASS_PROPERTY = /(?:^|[{,\s])((?:class|className|[A-Za-z_$][\w$]*ClassName))\s*:/g;
const CLASS_HELPER = /(?:^|[^\w$])(cn|clsx|classnames|cx|twMerge|cva|tv)\s*\(/g;
const CLASS_CONSTANT =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*(?:CLASS(?:ES)?|Class(?:Name)?e?s?|Styles))\s*=/g;

function tokensOf(scanned: ScannedSource, start: number, end: number): ClassToken[] {
  const tokens: ClassToken[] = [];
  for (const segment of scanned.strings) {
    if (segment.start < start || segment.end > end) continue;
    const matches = [...segment.text.matchAll(/\S+/g)];
    matches.forEach((match, index) => {
      // A token touching `${…}` is a fragment of a class no author wrote whole.
      if (index === 0 && segment.exprBefore && match.index === 0) return;
      if (
        index === matches.length - 1 &&
        segment.exprAfter &&
        match.index + match[0].length === segment.text.length
      ) {
        return;
      }
      tokens.push({ token: match[0], offset: segment.start + match.index });
    });
  }
  return tokens;
}

/**
 * Class strings, grouped by the expression that applies them. Mirrors the
 * roots the host's `component-contract` rules read: class attributes, the
 * class-merge helpers, and constants named like class strings. Deliberately not
 * every string in the file, which would read selectors and copy as classes.
 */
export function extractClassContexts(scanned: ScannedSource): ClassToken[][] {
  const { masked } = scanned;
  const ranges: Array<[number, number]> = [];
  const inside = (at: number) => ranges.some(([s, e]) => at >= s && at < e);

  for (const match of masked.matchAll(CLASS_PROPERTY)) {
    const valueStart = match.index + match[0].length;
    if (inside(valueStart)) continue;
    ranges.push([valueStart, expressionEnd(masked, valueStart)]);
  }
  for (const match of masked.matchAll(CLASS_CONSTANT)) {
    const valueStart = match.index + match[0].length;
    if (inside(valueStart)) continue;
    ranges.push([valueStart, expressionEnd(masked, valueStart)]);
  }
  for (const match of masked.matchAll(CLASS_HELPER)) {
    const open = match.index + match[0].length - 1;
    if (inside(open)) continue;
    const close = matchClose(masked, open);
    if (close > open) ranges.push([open, close]);
  }

  return ranges
    .map(([start, end]) => tokensOf(scanned, start, end))
    .filter((tokens) => tokens.length > 0);
}

const ELEMENT_FACTORIES = "_?jsxs?\\d*|jsxDEV\\d*|createElement";
const IDENTIFIER = "[A-Za-z_$][\\w$]*";

const ELEMENT_SOURCE = /^(?:react|preact(?:\/compat)?)$/;

/**
 * Local names bound to an element factory, so a zero-build view's
 * `import { createElement as h } from "react"`, `const h = React.createElement`,
 * `const { createElement: e } = React` or Preact's `h` is read like JSX.
 * Matched on the masked text, so a string that mentions one binds nothing.
 * Not scope-aware: an alias shadowed by a parameter of the same name is still
 * read as the factory, which only matters when that call's first argument is
 * a lowercase tag string.
 */
function factoryAliases(scanned: ScannedSource): string[] {
  const { code, masked } = scanned;
  const names = new Set<string>();
  // The source string is blanked in `masked`; read it from `code` at the same offsets.
  for (const match of masked.matchAll(/\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*/g)) {
    const at = match.index + match[0].length;
    const source = /^(["'])([^"']*)\1/.exec(code.slice(at, at + 64))?.[2] ?? "";
    if (!ELEMENT_SOURCE.test(source)) continue;
    for (const part of match[1]!.split(",")) {
      const binding = /^\s*(createElement|h)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (!binding) continue;
      // `h` is Preact's factory; React has no export by that name.
      if (binding[1] === "h" && source === "react") continue;
      names.add(binding[2] ?? binding[1]!);
    }
  }
  const assigned = new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*((?:${IDENTIFIER}\\s*\\.\\s*)*)createElement\\b(?!\\s*\\()`,
    "g"
  );
  for (const match of masked.matchAll(assigned)) {
    if (DOM_RECEIVER.test(match[2]!)) continue;
    names.add(match[1]!);
  }
  for (const match of masked.matchAll(
    new RegExp(`[{,]\\s*createElement\\s*:\\s*(${IDENTIFIER})\\s*(?=[,}])`, "g")
  )) {
    names.add(match[1]!);
  }
  names.delete("createElement");
  return [...names];
}

/** `document.createElement("button")` builds DOM, not a React element. */
const DOM_RECEIVER = /\b(?:document|ownerDocument|doc)\s*\.\s*$/;

/**
 * Every element creation: esbuild's `jsx("tag", {…})`, a zero-build view's
 * `createElement("tag", {…})` or `React.createElement(…)`, and the same called
 * through a local alias such as `h` — they all look the same once scanned.
 */
export function extractElements(scanned: ScannedSource): JsxElement[] {
  const aliases = factoryAliases(scanned).map((name) => name.replace(/\$/g, "\\$"));
  // An alias is a bare local, so `obj.h(` is someone else's method.
  const aliased = aliases.length > 0 ? `|(?<![\\w$.])(?:${aliases.join("|")})` : "";
  const call = new RegExp(`(?:(?<![\\w$])(?:${ELEMENT_FACTORIES})${aliased})\\s*\\(\\s*`, "g");
  const { code, masked } = scanned;
  const elements: JsxElement[] = [];
  for (const match of masked.matchAll(call)) {
    if (DOM_RECEIVER.test(masked.slice(Math.max(0, match.index - 32), match.index))) continue;
    const open = masked.lastIndexOf("(", match.index + match[0].length);
    const args = splitArgs(masked, open);
    const first = args[0];
    if (!first) continue;
    const head = code.slice(first[0], first[1]).trim();
    const literal = /^(["'])([a-z][a-z0-9-]*)\1$/.exec(head);
    const identifier = /^([A-Z][\w$]*)(?:\.[\w$]+)*$/.exec(head);
    if (!literal && !identifier) continue;
    const second = args[1];
    let props: [number, number] | null = null;
    if (second) {
      const slice = masked.slice(second[0], second[1]);
      const at = second[0] + (slice.length - slice.trimStart().length);
      if (masked[at] === "{") {
        const close = matchClose(masked, at);
        if (close > at) props = [at, close + 1];
      }
    }
    elements.push({
      tag: literal ? literal[2]! : identifier![1]!,
      intrinsic: literal !== null,
      offset: match.index,
      props,
    });
  }
  return elements;
}

/** Offset in `code` just past `key:` when the props object declares it at its top level. */
function propValueStart(scanned: ScannedSource, element: JsxElement, key: string): number {
  if (!element.props) return -1;
  const [start, end] = element.props;
  const { masked, code } = scanned;
  const re = new RegExp(`^\\s*["']?${key}["']?\\s*:`);
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = masked[i]!;
    // The opening brace falls through too, so the first member is checked.
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c !== "," || depth !== 1) continue;
    if (depth !== 1) continue;
    const match = re.exec(code.slice(i + 1, i + key.length + 64));
    if (match) return i + 1 + match[0].length;
  }
  return -1;
}

/** Whether the props object declares `key` at its top level. */
export function hasProp(scanned: ScannedSource, element: JsxElement, key: string): boolean {
  return propValueStart(scanned, element, key) >= 0;
}

/** The literal string value of a top-level prop, when it is one. */
export function propString(
  scanned: ScannedSource,
  element: JsxElement,
  key: string
): string | null {
  const at = propValueStart(scanned, element, key);
  if (at < 0) return null;
  const match = /^\s*(["'`])([^"'`]*)\1/.exec(scanned.code.slice(at, at + 512));
  return match ? match[2]! : null;
}

/**
 * The start of the member chain a call sits on — `window.electron.plugin.on(`
 * starts at `window` — and the first non-space character before it.
 */
export function chainStart(masked: string, at: number): number {
  let i = at;
  while (i > 0 && /[\w$.?]/.test(masked[i - 1]!)) i--;
  return i;
}

export function previousSignificant(masked: string, at: number): { char: string; word: string } {
  let i = at - 1;
  while (i >= 0 && /\s/.test(masked[i]!)) i--;
  if (i < 0) return { char: "", word: "" };
  let j = i;
  while (j >= 0 && /[\w$]/.test(masked[j]!)) j--;
  return { char: masked[i]!, word: masked.slice(j + 1, i + 1) };
}
