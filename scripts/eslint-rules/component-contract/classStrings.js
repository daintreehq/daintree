/**
 * Shared Tailwind class extraction for the `component-contract` rules.
 *
 * Generalises the walker in `../icon-opacity-dimming.js`: that rule only reads
 * the `className` of icon elements, but the contract rules also have to see
 * class strings that never touch JSX — `cva()` variant tables, the exported
 * `cn()` constants in `src/components/ui/paletteRowStyles.ts`, and helpers in
 * plain `.ts` modules.
 *
 * Roots are `className`/`class`/`*ClassName` JSX attributes, calls to the
 * class-merge helpers, and `const`s whose name marks them as class strings.
 * Every helper call a root already walked is remembered, so a nested
 * `className={cn(…)}` is neither walked twice nor — as an ancestor test would
 * have it — skipped when the root could not reach it (a call inside a callback,
 * say).
 *
 * Deliberately NOT every string literal in the file: CSS selector strings and
 * the class-string fixtures in `src/config/__tests__/*.contract.test.ts` (which
 * carry deliberate contract violations by design) would all be flagged.
 */

const CLASS_HELPERS = new Set(["cn", "clsx", "classnames", "cx", "twMerge", "cva", "tv"]);

/**
 * Helpers taking a variant table, and the index it sits at: `cva(base, config)`
 * puts it second, `tv(config)` first.
 */
const VARIANT_TABLE_HELPERS = new Map([
  ["cva", 1],
  ["tv", 0],
]);

/** `FOO_CLASS`, `rowClasses`, `paletteRowStyles` — conventional class-string constants. */
const CLASS_CONSTANT_NAME = /(?:CLASS(?:ES)?|Class(?:Name)?e?s?|Styles)$/;

/** Wrappers that carry no runtime meaning and must not hide the expression inside. */
const TRANSPARENT = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

function unwrap(node) {
  let current = node;
  while (current && TRANSPARENT.has(current.type)) current = current.expression;
  return current;
}

function helperName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

function isClassHelperCall(node) {
  return node.type === "CallExpression" && CLASS_HELPERS.has(helperName(node.callee) ?? "");
}

function isClassAttribute(node) {
  if (node.type !== "JSXAttribute" || node.name?.type !== "JSXIdentifier") return false;
  const { name } = node.name;
  return name === "className" || name === "class" || name.endsWith("ClassName");
}

/**
 * Walk a Tailwind candidate, returning the index of each top-level delimiter.
 * Quoted sections and escapes are skipped and every bracket flavour shares one
 * stack, so `[&[data-x='(']]:rounded` splits at the colon Tailwind splits at.
 * Unmatched closers cannot drive the depth negative and desync the rest.
 */
function topLevelIndexes(token, delimiter) {
  const indexes = [];
  const stack = [];
  let quote = null;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") {
      stack.push(ch);
      continue;
    }
    if (ch === "]" || ch === ")" || ch === "}") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    if (ch === delimiter && stack.length === 0) indexes.push(i);
  }
  return indexes;
}

/** Split a class token into its variant chain and the base utility. */
export function splitVariants(token) {
  const colons = topLevelIndexes(token, ":");
  if (colons.length === 0) return { variants: "", base: token };
  const last = colons[colons.length - 1];
  return { variants: token.slice(0, last), base: token.slice(last + 1) };
}

/** The individual variants in a chain, e.g. `dark:focus-visible` → ["dark", "focus-visible"]. */
export function variantSegments(variants) {
  if (!variants) return [];
  const colons = topLevelIndexes(variants, ":");
  const segments = [];
  let start = 0;
  for (const index of colons) {
    segments.push(variants.slice(start, index));
    start = index + 1;
  }
  segments.push(variants.slice(start));
  return segments.filter(Boolean);
}

/** Split off a trailing top-level `/modifier` (an alpha, or a line height). */
export function splitModifier(value) {
  const slashes = topLevelIndexes(value, "/");
  if (slashes.length === 0) return null;
  const last = slashes[slashes.length - 1];
  return { value: value.slice(0, last), modifier: value.slice(last + 1) };
}

/** Variant chain plus the base utility with v4's `!important` marker stripped from either end. */
export function normalizeToken(token) {
  const { variants, base } = splitVariants(token);
  return { variants, base: base.replace(/^!/, "").replace(/!$/, "") };
}

/**
 * Whitespace-separated tokens from one template-literal quasi, dropping the
 * fragments that abut an interpolation. Without this, `` `rounded${suffix}` ``
 * yields a bare `rounded` that no author ever wrote. `cooked` is used so an
 * escaped newline reads as the whitespace it becomes at runtime.
 */
function completeTokens(raw, continuesFromExpression, continuesIntoExpression) {
  const tokens = [];
  for (const match of raw.matchAll(/\S+/g)) {
    const atStart = match.index === 0;
    const atEnd = match.index + match[0].length === raw.length;
    if (atStart && continuesFromExpression) continue;
    if (atEnd && continuesIntoExpression) continue;
    tokens.push(match[0]);
  }
  return tokens;
}

const isBlankEdge = (text, side) =>
  text.length === 0 || /\s/.test(side === "end" ? text[text.length - 1] : text[0]);

/**
 * Build a visitor that hands every class-string root to `onEntries` as a flat
 * `{ token, node }[]` gathered across every branch, argument and object member.
 *
 * Passing the whole root at once (rather than reporting as the walk proceeds)
 * is what lets a rule decide from tokens that live in sibling arguments — the
 * focus-fallback rule needs exactly that, since the suppressor and its
 * replacement are routinely in different `cn()` arguments.
 */
export function createClassExpressionVisitor(context, onEntries) {
  const walkedCalls = new WeakSet();

  function pushString(value, node, entries) {
    for (const token of value.split(/\s+/)) {
      if (token) entries.push({ token, node });
    }
  }

  /**
   * A `cva()`/`tv()` config. Only class strings are collected: option names live
   * in the keys and in `defaultVariants`' values, and a `compoundVariants` entry
   * mixes option selectors with the classes they apply.
   */
  function collectVariantConfig(node, entries) {
    const config = unwrap(node);
    if (config?.type !== "ObjectExpression") return collect(config, entries, true);
    for (const property of config.properties) {
      if (property.type !== "Property") continue;
      const key = property.computed
        ? null
        : property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal"
            ? String(property.key.value)
            : null;
      if (key === "defaultVariants") continue;
      if (key === "compoundVariants") {
        const list = unwrap(property.value);
        if (list?.type !== "ArrayExpression") continue;
        for (const element of list.elements) {
          const entry = unwrap(element);
          if (entry?.type !== "ObjectExpression") continue;
          for (const inner of entry.properties) {
            if (inner.type !== "Property" || inner.computed) continue;
            const innerKey = inner.key.type === "Identifier" ? inner.key.name : null;
            if (innerKey === "class" || innerKey === "className") {
              collect(inner.value, entries, true);
            }
          }
        }
        continue;
      }
      collectVariantConfig(property.value, entries);
    }
  }

  function collect(node, entries, inHelperArguments) {
    const current = unwrap(node);
    if (!current) return;
    switch (current.type) {
      case "Literal":
        if (typeof current.value === "string") pushString(current.value, current, entries);
        break;
      case "TemplateLiteral":
        current.quasis.forEach((quasi, index) => {
          const text = quasi.value.cooked ?? quasi.value.raw;
          const tokens = completeTokens(text, index > 0, index < current.quasis.length - 1);
          for (const token of tokens) entries.push({ token, node: quasi });
        });
        // An interpolation that abuts non-whitespace is a fragment of a
        // neighbouring token (`${"rounded"}-lg`), not a class list of its own.
        current.expressions.forEach((expression, index) => {
          const before = current.quasis[index].value.cooked ?? current.quasis[index].value.raw;
          const after =
            current.quasis[index + 1].value.cooked ?? current.quasis[index + 1].value.raw;
          if (!isBlankEdge(before, "end") || !isBlankEdge(after, "start")) return;
          collect(expression, entries, inHelperArguments);
        });
        break;
      case "ConditionalExpression":
        collect(current.consequent, entries, inHelperArguments);
        collect(current.alternate, entries, inHelperArguments);
        break;
      case "LogicalExpression":
        collect(current.left, entries, inHelperArguments);
        collect(current.right, entries, inHelperArguments);
        break;
      case "CallExpression": {
        walkedCalls.add(current);
        const name = helperName(current.callee) ?? "";
        const configIndex = VARIANT_TABLE_HELPERS.get(name);
        if (configIndex !== undefined) {
          current.arguments.forEach((argument, index) => {
            if (index === configIndex) collectVariantConfig(argument, entries);
            else collect(argument, entries, true);
          });
          break;
        }
        for (const argument of current.arguments) collect(argument, entries, true);
        break;
      }
      case "ArrayExpression":
        for (const element of current.elements) collect(element, entries, inHelperArguments);
        break;
      case "ObjectExpression":
        // The `clsx({ "text-daintree-text": on })` form puts classes in the keys —
        // but only inside a class helper. A plain object reached from a
        // class-named constant is a lookup table, and its keys are labels.
        for (const property of current.properties) {
          if (property.type !== "Property") continue;
          if (inHelperArguments && !property.computed) {
            const key =
              property.key.type === "Literal" && typeof property.key.value === "string"
                ? property.key.value
                : property.key.type === "Identifier"
                  ? property.key.name
                  : null;
            if (key !== null) pushString(key, property.key, entries);
          }
          collect(property.value, entries, inHelperArguments);
        }
        break;
      default:
        break;
    }
  }

  function report(node) {
    const entries = [];
    collect(node, entries, false);
    if (entries.length > 0) onEntries(entries, node);
  }

  return {
    JSXAttribute(node) {
      if (!isClassAttribute(node) || !node.value) return;
      if (node.value.type === "JSXExpressionContainer") report(node.value.expression);
      else report(node.value);
    },

    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (!CLASS_CONSTANT_NAME.test(node.id.name)) return;
      report(node.init);
    },

    CallExpression(node) {
      if (!isClassHelperCall(node) || walkedCalls.has(node)) return;
      report(node);
    },
  };
}
