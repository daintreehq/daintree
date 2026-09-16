import type {
  CompiledCandidate,
  CompiledDeclaration,
  DeclarationScope,
  TailwindDesignSystem,
} from "./designSystem.js";

/**
 * Candidate-level questions the inspector asks: is this token real in *this*
 * project, what does it actually do, and which of its declarations author a
 * value rather than wire up Tailwind's own composition machinery.
 */

export interface CandidateDescription {
  candidate: string;
  /** Generated CSS, verbatim — the completion preview shows Tailwind's answer. */
  css: string;
  /** Properties the candidate declares, `@property` registers excluded. */
  properties: string[];
}

/** Utilities tried, in order, as the carrier for a scope probe. */
export const SCOPE_PROBES = ["block", "flex", "underline", "italic"];

export function isValidCandidate(system: TailwindDesignSystem, candidate: string): boolean {
  return system.cssFor(candidate) !== null;
}

export function describeCandidate(
  system: TailwindDesignSystem,
  candidate: string
): CandidateDescription | null {
  const css = system.cssFor(candidate);
  if (css === null) return null;
  const compiled = system.compile(candidate);
  const properties: string[] = [];
  for (const declaration of compiled?.declarations ?? []) {
    if (!properties.includes(declaration.property)) properties.push(declaration.property);
  }
  return { candidate, css, properties };
}

/** Stable key for a declaration's scope; equal keys mean the two compete. */
export function scopeKey(scope: DeclarationScope): string {
  return `${scope.conditions.join(" && ")}|${scope.selector}`;
}

/**
 * The scope a whole candidate authors in, or null when it authors in more than
 * one (rare, but a utility may emit several rules). Callers that need
 * per-declaration precision use `compile` directly.
 */
export function candidateScopeKey(system: TailwindDesignSystem, candidate: string): string | null {
  const compiled = system.compile(candidate);
  if (!compiled || compiled.declarations.length === 0) return null;
  const keys = new Set(compiled.declarations.map((declaration) => scopeKey(declaration.scope)));
  return keys.size === 1 ? [...keys][0]! : null;
}

/** Composes `prefix:variant:utility`, omitting the parts this project lacks. */
export function composeCandidate(
  system: TailwindDesignSystem,
  variant: string | null,
  utility: string
): string {
  const parts: string[] = [];
  if (system.prefix) parts.push(system.prefix);
  if (variant) parts.push(variant);
  parts.push(utility);
  return parts.join(":");
}

/**
 * The scope key a variant chain produces, so tokens can be grouped by the
 * condition they author under without re-deriving Tailwind's variant ordering.
 * `null` when no probe compiles under that chain — an unusable variant.
 */
export function scopeKeyForVariant(
  system: TailwindDesignSystem,
  variant: string | null
): string | null {
  for (const probe of SCOPE_PROBES) {
    const candidate = composeCandidate(system, variant, probe);
    if (system.cssFor(candidate) === null) continue;
    return candidateScopeKey(system, candidate);
  }
  return null;
}

/**
 * How a declaration participates in a conflict.
 *
 * - `authored` — it writes a value the user chose. Two of these on one property
 *   are a real conflict.
 * - `assembly` — it only re-assembles `--tw-*` registers: `box-shadow:
 *   var(--tw-shadow), …`, `filter: var(--tw-blur,) …`, `line-height:
 *   var(--tw-leading, …)`. Every member of a composing family emits an
 *   identical copy, so two of these never conflict — but one of them against an
 *   *authored* value for the same property does (`shadow-md` really is
 *   overridden by `[box-shadow:none]`), unless the authored side sets a
 *   register this one reads, which is composition working as designed.
 */
export type DeclarationRole = "authored" | "assembly";

export interface CandidateSlot {
  slot: string;
  role: DeclarationRole;
  /** Registers an `assembly` declaration reads. Empty for `authored`. */
  reads: string[];
}

/** Whether a declaration only re-assembles registers rather than authoring. */
export function isRegisterAssembly(
  system: TailwindDesignSystem,
  compiled: CompiledCandidate,
  declaration: CompiledDeclaration
): boolean {
  if (declaration.property.startsWith("--")) return false;
  if (!declaration.value.includes("var(--tw-")) return false;
  return stripRegisterVars(system, compiled, declaration.value).trim().length === 0;
}

/**
 * Custom properties this candidate declares — the registers it *sets*, which is
 * how a composing partner is recognised: `leading-7` sets `--tw-leading`, which
 * is exactly the register `text-lg`'s `line-height` reads.
 */
export function registersSetBy(compiled: CompiledCandidate): string[] {
  return compiled.declarations
    .filter((declaration) => declaration.property.startsWith("--"))
    .map((declaration) => declaration.property);
}

/**
 * True when a custom-property declaration is machinery rather than a value:
 * either it is pure assembly (`--tw-gradient-stops: var(--tw-gradient-from) …`,
 * which every gradient stop emits identically) or it re-states the register's
 * own `initial-value` (`space-x-4` writing `--tw-space-x-reverse: 0`).
 */
export function isRegisterHousekeeping(
  system: TailwindDesignSystem,
  compiled: CompiledCandidate,
  declaration: CompiledDeclaration
): boolean {
  if (!declaration.property.startsWith("--")) return false;
  const initial = compiled.registers[declaration.property];
  if (initial !== undefined && initial === declaration.value.trim()) return true;
  if (!declaration.value.includes("var(--tw-")) return false;
  return stripRegisterVars(system, compiled, declaration.value).trim().length === 0;
}

/** Register names a value reads, e.g. `--tw-leading` from `var(--tw-leading, …)`. */
export function registersReadBy(
  system: TailwindDesignSystem,
  compiled: CompiledCandidate,
  value: string
): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/var\(\s*(--tw-[a-zA-Z0-9_-]*)/g)) {
    const name = match[1] ?? "";
    if (!name || names.includes(name)) continue;
    if (compiled.registers[name] === undefined && system.isThemeVariable(name)) continue;
    names.push(name);
  }
  return names;
}

function stripRegisterVars(
  system: TailwindDesignSystem,
  compiled: CompiledCandidate,
  value: string
): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("var(", index) && /^var\(\s*--tw-/.test(value.slice(index, index + 32))) {
      let depth = 0;
      let cursor = index + 3;
      for (; cursor < value.length; cursor++) {
        if (value[cursor] === "(") depth++;
        else if (value[cursor] === ")" && --depth === 0) break;
      }
      const name =
        value
          .slice(index + 4, cursor)
          .split(/[,)]/)[0]
          ?.trim() ?? "";
      // A reference to a theme variable is authored content. Under a `tw`
      // prefix the theme's own variables are emitted as `--tw-*` too, so the
      // name alone cannot tell machinery from a colour the user picked.
      const machinery = compiled.registers[name] !== undefined || !system.isThemeVariable(name);
      if (machinery && cursor < value.length) {
        index = cursor + 1;
        continue;
      }
    }
    const char = value[index] as string;
    if (!/[\s,/]/.test(char)) out += char;
    index++;
  }
  return out;
}

/**
 * Whether Tailwind's source scanner would see this candidate in `source`.
 *
 * v4 scans files as plain text and only generates a utility it finds as an
 * unbroken literal run. A class assembled at runtime (`bg-{color}-500`) reaches
 * the DOM with no rule behind it, so this is the check that separates "the
 * class is valid" from "the class will exist".
 */
export function appearsAsLiteralToken(source: string, candidate: string): boolean {
  let from = 0;
  for (;;) {
    const at = source.indexOf(candidate, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : source[at - 1];
    const after = source[at + candidate.length] ?? "";
    const bounded = (char: string | undefined) =>
      char === undefined || char === "" || /[\s"'`]/.test(char);
    if (bounded(before) && bounded(after)) return true;
    from = at + 1;
  }
}
