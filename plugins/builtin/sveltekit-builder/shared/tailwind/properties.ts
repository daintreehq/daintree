import {
  composeCandidate,
  isRegisterAssembly,
  isRegisterHousekeeping,
  scopeKey,
  scopeKeyForVariant,
} from "./candidates.js";
import { expandProperty } from "./conflicts.js";
import type { TailwindDesignSystem } from "./designSystem.js";

/**
 * The bridge between an inspector control and a Tailwind token, in both
 * directions. The supported set is deliberately small: every entry is a
 * property whose utility shape is a stable `prefix-value` pair, and the
 * proposal is *verified* against generated CSS before it is offered. An
 * unmapped property is reported as a gap so the UI can fall back to the raw
 * class editor or an agent task — it is never guessed at.
 */

export interface PropertyMapping {
  /** Utility stem, e.g. `px` for `padding-inline`. */
  prefix: string;
  /** CSS properties, pre-expansion, a correct candidate must declare. */
  declares: readonly string[];
}

export const PROPERTY_MAPPINGS: Record<string, PropertyMapping> = {
  padding: { prefix: "p", declares: ["padding"] },
  "padding-inline": { prefix: "px", declares: ["padding-inline"] },
  "padding-block": { prefix: "py", declares: ["padding-block"] },
  "padding-top": { prefix: "pt", declares: ["padding-top"] },
  "padding-right": { prefix: "pr", declares: ["padding-right"] },
  "padding-bottom": { prefix: "pb", declares: ["padding-bottom"] },
  "padding-left": { prefix: "pl", declares: ["padding-left"] },
  margin: { prefix: "m", declares: ["margin"] },
  "margin-inline": { prefix: "mx", declares: ["margin-inline"] },
  "margin-block": { prefix: "my", declares: ["margin-block"] },
  "margin-top": { prefix: "mt", declares: ["margin-top"] },
  "margin-bottom": { prefix: "mb", declares: ["margin-bottom"] },
  gap: { prefix: "gap", declares: ["gap"] },
  "column-gap": { prefix: "gap-x", declares: ["column-gap"] },
  "row-gap": { prefix: "gap-y", declares: ["row-gap"] },
  width: { prefix: "w", declares: ["width"] },
  height: { prefix: "h", declares: ["height"] },
  "max-width": { prefix: "max-w", declares: ["max-width"] },
  "font-size": { prefix: "text", declares: ["font-size"] },
  "font-weight": { prefix: "font", declares: ["font-weight", "--tw-font-weight"] },
  "line-height": { prefix: "leading", declares: ["line-height", "--tw-leading"] },
  "text-align": { prefix: "text", declares: ["text-align"] },
  color: { prefix: "text", declares: ["color"] },
  "background-color": { prefix: "bg", declares: ["background-color"] },
  "border-radius": { prefix: "rounded", declares: ["border-radius"] },
  "border-width": { prefix: "border", declares: ["border-width"] },
  "border-color": { prefix: "border", declares: ["border-color"] },
  opacity: { prefix: "opacity", declares: ["opacity"] },
};

export type ProposalResult =
  | { status: "ok"; candidate: string }
  | { status: "unsupported-property"; property: string }
  | { status: "invalid-value"; property: string; attempted: string };

export interface AuthoredToken {
  token: string;
  /**
   * The candidate's value segment, e.g. `4` for `md:p-4` — but only when the
   * token is this control's own utility. `p-4` seen through the
   * `padding-inline` control is real and must be shown, yet its value is not
   * one this control can re-propose, so it reports `null` rather than a string
   * that would round-trip into `px-p-4`.
   */
  value: string | null;
  /** The declared CSS value, e.g. `calc(var(--spacing) * 4)`. */
  declared: string;
}

export type AuthoredValueResult =
  | { status: "unsupported-property"; property: string }
  /** More than one entry means more than one token touches this property. */
  | { status: "ok"; property: string; variant: string | null; tokens: AuthoredToken[] };

/**
 * Build the candidate that sets `property` to `value` in `variant` scope, and
 * prove it: a valid candidate that declares something else (`text-4` is not a
 * font size) is rejected rather than written.
 */
export function proposeCandidate(
  system: TailwindDesignSystem,
  property: string,
  value: string,
  variant: string | null = null
): ProposalResult {
  const mapping = PROPERTY_MAPPINGS[property];
  if (!mapping) return { status: "unsupported-property", property };

  const negative = value.startsWith("-");
  const stem = negative ? `-${mapping.prefix}` : mapping.prefix;
  const body = negative ? value.slice(1) : value;
  const candidate = composeCandidate(system, variant, `${stem}-${body}`);

  return declaresProperty(system, candidate, mapping)
    ? { status: "ok", candidate }
    : { status: "invalid-value", property, attempted: candidate };
}

/** What the token list currently authors for `property` in one variant scope. */
export function readAuthoredValue(
  system: TailwindDesignSystem,
  tokens: string[],
  property: string,
  variant: string | null = null
): AuthoredValueResult {
  const mapping = PROPERTY_MAPPINGS[property];
  if (!mapping) return { status: "unsupported-property", property };

  const target = scopeKeyForVariant(system, variant);
  // A variant chain this project cannot compile authors nothing. Matching every
  // scope instead would report a base token as if it were the one at `variant`.
  if (target === null) return { status: "ok", property, variant, tokens: [] };
  const slots = new Set(mapping.declares.flatMap((declared) => expandProperty(declared)));
  const matched: AuthoredToken[] = [];

  for (const token of tokens) {
    const compiled = system.compile(token);
    for (const declaration of compiled?.declarations ?? []) {
      if (!compiled) continue;
      if (scopeKey(declaration.scope) !== target) continue;
      // A composition wire-up is not an authored value: `text-lg` emits a
      // `line-height` that only reads `--tw-leading`, and reporting it as the
      // authored line height would invite the inspector to overwrite it.
      if (isRegisterAssembly(system, compiled, declaration)) continue;
      if (isRegisterHousekeeping(system, compiled, declaration)) continue;
      if (!expandProperty(declaration.property).some((slot) => slots.has(slot))) continue;
      matched.push({
        token,
        value: valueSegment(token, mapping.prefix),
        declared: declaration.value,
      });
      break;
    }
  }

  return { status: "ok", property, variant, tokens: matched };
}

function declaresProperty(
  system: TailwindDesignSystem,
  candidate: string,
  mapping: PropertyMapping
): boolean {
  const compiled = system.compile(candidate);
  if (!compiled || compiled.declarations.length === 0) return false;
  const wanted = new Set(mapping.declares.flatMap((declared) => expandProperty(declared)));
  return compiled.declarations.some((declaration) =>
    expandProperty(declaration.property).some((slot) => wanted.has(slot))
  );
}

/**
 * Strips the prefix, the variant chain and the utility stem back off a token,
 * or `null` when the token is not this control's utility.
 *
 * The chain is split outside brackets only: `bg-[color:var(--brand)]` and the
 * arbitrary property `[mask-type:luminance]` carry colons inside their
 * brackets, and splitting on the last colon hands back a fragment like
 * `luminance]` instead of the value.
 */
function valueSegment(token: string, prefix: string): string | null {
  const utility = utilityOf(token);
  const negative = utility.startsWith("-");
  const bare = negative ? utility.slice(1) : utility;
  if (!bare.startsWith(`${prefix}-`)) return null;
  const stripped = bare.slice(prefix.length + 1);
  if (stripped === "") return null;
  return negative ? `-${stripped}` : stripped;
}

function utilityOf(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start);
}
