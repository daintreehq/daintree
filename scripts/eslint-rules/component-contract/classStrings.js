/**
 * Shared Tailwind class extraction for the `component-contract` rules.
 *
 * Generalises the walker in `../icon-opacity-dimming.js`: that rule only reads
 * the `className` of icon elements, but the contract rules also have to see
 * class strings that never touch JSX — `cva()` variant tables, the exported
 * `cn()` constants in `src/components/ui/paletteRowStyles.ts`, and helpers in
 * plain `.ts` modules.
 *
 * Roots are `className`/`class` JSX attributes and calls to the class-merge
 * helpers. A root nested inside another root is skipped so a `className={cn(…)}`
 * is not walked twice and every token reported twice.
 *
 * Deliberately NOT every string literal in the file: CSS selector strings and
 * the class-string fixtures in `src/config/__tests__/*.contract.test.ts` (which
 * carry deliberate contract violations by design) would all be flagged.
 */

const CLASS_HELPERS = new Set(["cn", "clsx", "classnames", "cx", "twMerge", "cva", "tv"]);

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
  return node.name.name === "className" || node.name.name === "class";
}

/**
 * Split a class token into its variant chain and the base utility, tolerating
 * the colons inside arbitrary variants (`data-[state=open]:`) and arbitrary
 * values (`text-[color:var(--x)]`) — only a colon at bracket depth zero
 * separates a variant from what follows.
 */
export function splitVariants(token) {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) lastColon = i;
  }
  if (lastColon === -1) return { variants: "", base: token };
  return { variants: token.slice(0, lastColon), base: token.slice(lastColon + 1) };
}

/** Variant chain plus the base utility with v4's `!important` marker stripped from either end. */
export function normalizeToken(token) {
  const { variants, base } = splitVariants(token);
  return { variants, base: base.replace(/^!/, "").replace(/!$/, "") };
}

/**
 * Whitespace-separated tokens from one template-literal quasi, dropping the
 * fragments that abut an interpolation. Without this, `` `rounded${suffix}` ``
 * yields a bare `rounded` that no author ever wrote.
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
  const sourceCode = context.sourceCode;

  function collect(node, entries) {
    if (!node) return;
    switch (node.type) {
      case "Literal":
        if (typeof node.value === "string") {
          for (const token of node.value.split(/\s+/)) {
            if (token) entries.push({ token, node });
          }
        }
        break;
      case "TemplateLiteral":
        node.quasis.forEach((quasi, index) => {
          const tokens = completeTokens(quasi.value.raw, index > 0, index < node.quasis.length - 1);
          for (const token of tokens) entries.push({ token, node: quasi });
        });
        for (const expression of node.expressions) collect(expression, entries);
        break;
      case "ConditionalExpression":
        collect(node.consequent, entries);
        collect(node.alternate, entries);
        break;
      case "LogicalExpression":
        collect(node.left, entries);
        collect(node.right, entries);
        break;
      case "CallExpression":
        for (const argument of node.arguments) collect(argument, entries);
        break;
      case "ArrayExpression":
        for (const element of node.elements) collect(element, entries);
        break;
      case "ObjectExpression":
        // Keys carry the classes in the `clsx({ "text-daintree-text": on })`
        // form; values carry them in a `cva()` variant table. Both are real.
        for (const property of node.properties) {
          if (property.type !== "Property") continue;
          if (!property.computed) {
            const key =
              property.key.type === "Literal" && typeof property.key.value === "string"
                ? property.key.value
                : property.key.type === "Identifier"
                  ? property.key.name
                  : null;
            if (key !== null) {
              for (const token of key.split(/\s+/)) {
                if (token) entries.push({ token, node: property.key });
              }
            }
          }
          collect(property.value, entries);
        }
        break;
      default:
        break;
    }
  }

  function isNestedRoot(node) {
    return sourceCode
      .getAncestors(node)
      .some((ancestor) => isClassAttribute(ancestor) || isClassHelperCall(ancestor));
  }

  function report(node) {
    const entries = [];
    collect(node, entries);
    if (entries.length > 0) onEntries(entries, node);
  }

  return {
    JSXAttribute(node) {
      if (!isClassAttribute(node) || !node.value) return;
      if (node.value.type === "JSXExpressionContainer") report(node.value.expression);
      else report(node.value);
    },

    CallExpression(node) {
      if (!isClassHelperCall(node) || isNestedRoot(node)) return;
      report(node);
    },
  };
}
