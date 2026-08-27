/**
 * One font-size classifier, shared by `no-arbitrary-text-size` and
 * `no-text-color-slash-alpha`.
 *
 * The `text-*` namespace is overloaded: `text-sm` and `text-[11px]` set a font
 * size, `text-red-500` and `text-[#abc]` set a colour, and a trailing `/…` means
 * a line height on the first and an alpha on the second. Both rules therefore
 * need the same answer to "is this value a size?", and disagreeing classifiers
 * would make one rule's legal spelling the other's violation.
 */

/** CSS length units Tailwind accepts in an arbitrary font size. */
const UNIT =
  "px|rem|em|pt|pc|in|cm|mm|Q|ex|ch|cap|ic|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|cqmin|cqmax|%";

const LENGTH = new RegExp(`^-?(?:\\d*\\.)?\\d+(?:${UNIT})$`);

const MATH = /^(?:calc|min|max|clamp)\(/;

const ABSOLUTE_SIZE =
  /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/;

/** Named steps: Tailwind's stock scale plus the `2xs`/`3xs` shape a custom step would take. */
const NAMED_STEP = /^(?:[2-9]?xs|sm|base|lg|[2-9]?xl)$/;

/** The bracket or paren body of an arbitrary value, or null when it is not one. */
export function arbitraryBody(value) {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  if (value.startsWith("(") && value.endsWith(")")) return value.slice(1, -1);
  return null;
}

/**
 * Whether the value after `text-` sets a font size rather than a colour.
 * An unhinted custom property (`text-(--x)`, `text-[var(--x)]`) is a colour:
 * that is what Tailwind falls back to, so a size there needs the `length:` hint.
 */
export function isFontSizeValue(value) {
  const body = arbitraryBody(value);
  if (body === null) return NAMED_STEP.test(value);
  if (body.startsWith("length:")) return true;
  if (body.startsWith("color:")) return false;
  const normalized = body.replaceAll("_", " ").trim();
  return LENGTH.test(normalized) || MATH.test(normalized) || ABSOLUTE_SIZE.test(normalized);
}
