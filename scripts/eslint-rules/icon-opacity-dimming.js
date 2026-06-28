/**
 * ESLint rule: no-icon-opacity-dimming
 *
 * Bans opacity-based dimming on icons. Icons must be de-emphasized with a solid,
 * fully-opaque theme token (e.g. `text-text-muted`), never with `opacity-*`
 * utilities or the `grayscale` filter. Both composite the icon against whatever
 * sits behind it, so the same class produces a different, muddy result on each
 * theme background instead of a crisp token color that every palette validates.
 *
 * Scope: the `className` of `<svg>` elements and of icon components — any JSX
 * element imported from `lucide-react` or `@/components/icons`, or whose name
 * ends in `Icon`. The name check also covers member access (`row.Icon`) and
 * brand glyphs (`GitHubIcon`). Non-icon elements (buttons, cards, panes) are
 * out of scope; their disabled/exited opacity states are legitimate.
 *
 * Flagged in plain string literals, template literals, and the arguments of
 * class-merge helpers (`cn`/`clsx`/`classnames`/`cx`/`twMerge`), including
 * ternary and `&&` branches and array/object forms:
 *   - bare `opacity-<value>` other than `opacity-0` / `opacity-100`
 *     (those are visibility toggles, not dimming)
 *   - the `grayscale` utility
 * Modifier-prefixed forms (`hover:opacity-50`, `disabled:opacity-50`,
 * `data-[disabled]:opacity-50`) are not flagged — the modifier means the dim is
 * a scoped interaction state, not a baseline icon color.
 *
 * Legitimate exceptions (a real visibility toggle on an icon, say) opt out with:
 *   // eslint-disable-next-line icon-opacity-dimming/no-icon-opacity-dimming -- <reason>
 */

const ICON_IMPORT_SOURCES = new Set(["lucide-react", "@/components/icons"]);

/** A class token is a banned opacity utility (anything but opacity-0 / opacity-100). */
function isBannedOpacityToken(token) {
  if (!token.startsWith("opacity-")) return false;
  return token !== "opacity-0" && token !== "opacity-100";
}

function isGrayscaleToken(token) {
  return token === "grayscale";
}

/** Return all offending token types found in a class string. */
function findViolations(value) {
  const violations = [];
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    if (isBannedOpacityToken(token) && !violations.includes("opacity")) {
      violations.push("opacity");
    }
    if (isGrayscaleToken(token) && !violations.includes("grayscale")) {
      violations.push("grayscale");
    }
  }
  return violations;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow opacity-based dimming on icons; use a solid theme token instead",
      recommended: true,
    },
    schema: [],
    messages: {
      opacity:
        "Don't dim icons with `opacity-*`. Use a solid theme token (e.g. `text-text-muted`). Genuine visibility toggles opt out with `// eslint-disable-next-line icon-opacity-dimming/no-icon-opacity-dimming -- <reason>`.",
      grayscale:
        "Don't desaturate icons with `grayscale`. Use a solid theme token (e.g. `text-text-muted`) for the disabled state.",
    },
  },

  create(context) {
    /** Local identifiers known to resolve to icon components. */
    const iconNames = new Set();

    function elementName(nameNode) {
      if (!nameNode) return null;
      if (nameNode.type === "JSXIdentifier") return nameNode.name;
      // <row.Icon /> → JSXMemberExpression; the property carries the meaning.
      if (nameNode.type === "JSXMemberExpression" && nameNode.property.type === "JSXIdentifier") {
        return nameNode.property.name;
      }
      return null;
    }

    function isIconElement(nameNode) {
      if (nameNode?.type === "JSXIdentifier" && nameNode.name === "svg") return true;
      const name = elementName(nameNode);
      if (!name) return false;
      if (iconNames.has(name)) return true;
      return /Icon$/.test(name);
    }

    /** Report all banned tokens found in a class string literal node. */
    function checkClassString(value, node) {
      const violations = findViolations(value);
      for (const violation of violations) {
        context.report({ node, messageId: violation });
      }
    }

    /** Walk an expression that contributes class strings (cn() args, ternaries, …). */
    function checkExpression(node) {
      if (!node) return;
      switch (node.type) {
        case "Literal":
          if (typeof node.value === "string") checkClassString(node.value, node);
          break;
        case "TemplateLiteral":
          for (const quasi of node.quasis) checkClassString(quasi.value.raw, quasi);
          for (const expr of node.expressions) checkExpression(expr);
          break;
        case "ConditionalExpression":
          checkExpression(node.consequent);
          checkExpression(node.alternate);
          break;
        case "LogicalExpression":
          checkExpression(node.left);
          checkExpression(node.right);
          break;
        case "CallExpression":
          for (const arg of node.arguments) checkExpression(arg);
          break;
        case "ArrayExpression":
          for (const element of node.elements) checkExpression(element);
          break;
        case "ObjectExpression":
          // clsx object form: { "opacity-50": cond } and { grayscale: cond }
          for (const prop of node.properties) {
            if (prop.type !== "Property" || prop.computed) continue;
            if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
              checkClassString(prop.key.value, prop.key);
            } else if (prop.key.type === "Identifier") {
              checkClassString(prop.key.name, prop.key);
            }
          }
          break;
        default:
          break;
      }
    }

    return {
      ImportDeclaration(node) {
        const source = typeof node.source.value === "string" ? node.source.value : "";
        const fromIconSource = ICON_IMPORT_SOURCES.has(source);
        for (const spec of node.specifiers) {
          const local = spec.local?.name;
          if (!local) continue;
          if (fromIconSource || /Icon$/.test(local)) iconNames.add(local);
        }
      },

      JSXOpeningElement(node) {
        if (!isIconElement(node.name)) return;
        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute") continue;
          if (attr.name?.name !== "className" || !attr.value) continue;
          if (attr.value.type === "Literal") {
            if (typeof attr.value.value === "string") {
              checkClassString(attr.value.value, attr.value);
            }
          } else if (attr.value.type === "JSXExpressionContainer") {
            checkExpression(attr.value.expression);
          }
        }
      },
    };
  },
};
