import {
  isRegisterAssembly,
  isRegisterHousekeeping,
  registersReadBy,
  registersSetBy,
  scopeKey,
  type CandidateSlot,
} from "./candidates.js";
import type { TailwindDesignSystem } from "./designSystem.js";

/**
 * Which existing tokens a new candidate would fight with.
 *
 * Derived from the CSS the candidates actually generate, never from a table of
 * utility families: the project may rename utilities, add plugins, or define
 * its own, and any hand-kept group list is wrong the moment it does. Two
 * candidates conflict when, inside the *same* scope — same at-rule conditions,
 * same selector shape — they write an overlapping set of physical boxes, and
 * neither write is Tailwind's own composition machinery.
 *
 * The one table here is CSS shorthand expansion, which is a property of CSS and
 * not of Tailwind: `padding` covers the four sides that `padding-inline` covers
 * two of, and no amount of reading generated declarations reveals that.
 */

export interface TokenConflict {
  token: string;
  /** Slots both tokens write, e.g. `padding-left`. */
  properties: string[];
}

export interface ConflictReport {
  candidate: string;
  conflicts: TokenConflict[];
  /** Existing tokens Tailwind does not recognise; they are kept, never removed. */
  unresolved: string[];
}

interface ScopedSlots {
  slots: Map<string, CandidateSlot[]>;
  /** Registers the candidate sets, shared across its scopes. */
  sets: string[];
}

export function findConflicts(
  system: TailwindDesignSystem,
  existingTokens: string[],
  candidate: string
): ConflictReport {
  const incoming = slotsByScope(system, candidate);
  const conflicts: TokenConflict[] = [];
  const unresolved: string[] = [];

  for (const token of existingTokens) {
    if (token === candidate) continue;
    if (system.compile(token) === null) {
      unresolved.push(token);
      continue;
    }
    const existing = slotsByScope(system, token);
    const overlap = new Set<string>();
    for (const [scope, slots] of existing.slots) {
      const rivals = incoming.slots.get(scope);
      if (!rivals) continue;
      for (const slot of slots) {
        for (const rival of rivals) {
          if (rival.slot !== slot.slot) continue;
          if (competes(slot, existing.sets, rival, incoming.sets)) overlap.add(slot.slot);
        }
      }
    }
    if (overlap.size > 0) conflicts.push({ token, properties: [...overlap].sort() });
  }

  return { candidate, conflicts, unresolved };
}

function competes(
  left: CandidateSlot,
  leftSets: string[],
  right: CandidateSlot,
  rightSets: string[]
): boolean {
  if (left.role === "authored" && right.role === "authored") return true;
  if (left.role === "assembly" && right.role === "assembly") return false;
  const [assembly, authorSets] =
    left.role === "assembly" ? ([left, rightSets] as const) : ([right, leftSets] as const);
  // The authored side feeding a register this assembly reads is composition,
  // not rivalry — `leading-7` sets exactly the `--tw-leading` that `text-lg`'s
  // own `line-height` reads back.
  return !assembly.reads.some((register) => authorSets.includes(register));
}

function slotsByScope(system: TailwindDesignSystem, candidate: string): ScopedSlots {
  const slots = new Map<string, CandidateSlot[]>();
  const compiled = system.compile(candidate);
  if (!compiled) return { slots, sets: [] };

  for (const declaration of compiled.declarations) {
    if (isRegisterHousekeeping(system, compiled, declaration)) continue;
    const key = scopeKey(declaration.scope);
    const assembly = isRegisterAssembly(system, compiled, declaration);
    const entries = assembly
      ? [
          {
            slot: declaration.property,
            role: "assembly" as const,
            reads: registersReadBy(system, compiled, declaration.value),
          },
        ]
      : expandProperty(declaration.property, directionOf(declaration.scope.selector)).map(
          (slot) => ({ slot, role: "authored" as const, reads: [] })
        );
    slots.set(key, [...(slots.get(key) ?? []), ...entries]);
  }

  return { slots, sets: registersSetBy(compiled) };
}

export type WritingDirection = "ltr" | "rtl";

/**
 * Logical sides only collapse onto physical ones once a direction is known, and
 * the direction is in the scope: Tailwind's `rtl:` variant lands a `:dir(rtl)`
 * selector on the rule. Both sides of a comparison share a scope by
 * construction, so the mapping is never applied across two directions.
 */
function directionOf(selector: string): WritingDirection {
  return /dir\(\s*rtl\s*\)|\[dir="rtl"\]/.test(selector) ? "rtl" : "ltr";
}

const BOX_SIDES = ["top", "right", "bottom", "left"] as const;

const LOGICAL_SIDES: Record<WritingDirection, Record<string, readonly string[]>> = {
  ltr: {
    "": BOX_SIDES,
    inline: ["left", "right"],
    block: ["top", "bottom"],
    "inline-start": ["left"],
    "inline-end": ["right"],
    "block-start": ["top"],
    "block-end": ["bottom"],
    start: ["left"],
    end: ["right"],
    top: ["top"],
    right: ["right"],
    bottom: ["bottom"],
    left: ["left"],
  },
  rtl: {
    "": BOX_SIDES,
    inline: ["left", "right"],
    block: ["top", "bottom"],
    "inline-start": ["right"],
    "inline-end": ["left"],
    "block-start": ["top"],
    "block-end": ["bottom"],
    start: ["right"],
    end: ["left"],
    top: ["top"],
    right: ["right"],
    bottom: ["bottom"],
    left: ["left"],
  },
};

const CORNERS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
] as const;

const BORDER_KINDS = ["width", "style", "color"] as const;

const BORDER_LONGHANDS = BOX_SIDES.flatMap((side) =>
  BORDER_KINDS.map((kind) => `border-${side}-${kind}`)
);

const EXPANSIONS: Record<string, readonly string[]> = {
  gap: ["row-gap", "column-gap"],
  overflow: ["overflow-x", "overflow-y"],
  "overscroll-behavior": ["overscroll-behavior-x", "overscroll-behavior-y"],
  "place-items": ["align-items", "justify-items"],
  "place-content": ["align-content", "justify-content"],
  "place-self": ["align-self", "justify-self"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
  "flex-flow": ["flex-direction", "flex-wrap"],
  "grid-area": ["grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end"],
  "grid-row": ["grid-row-start", "grid-row-end"],
  "grid-column": ["grid-column-start", "grid-column-end"],
  "border-radius": CORNERS,
  "border-start-start-radius": ["border-top-left-radius"],
  "border-start-end-radius": ["border-top-right-radius"],
  "border-end-end-radius": ["border-bottom-right-radius"],
  "border-end-start-radius": ["border-bottom-left-radius"],
  border: BORDER_LONGHANDS,
  outline: ["outline-width", "outline-style", "outline-color"],
  background: [
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "background-attachment",
    "background-origin",
    "background-clip",
  ],
  font: [
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-size",
    "line-height",
    "font-family",
  ],
  transition: [
    "transition-property",
    "transition-duration",
    "transition-timing-function",
    "transition-delay",
    "transition-behavior",
  ],
  animation: [
    "animation-name",
    "animation-duration",
    "animation-timing-function",
    "animation-delay",
    "animation-iteration-count",
    "animation-direction",
    "animation-fill-mode",
    "animation-play-state",
  ],
  "list-style": ["list-style-type", "list-style-position", "list-style-image"],
  "inline-size": ["width"],
  "block-size": ["height"],
  "min-inline-size": ["min-width"],
  "min-block-size": ["min-height"],
  "max-inline-size": ["max-width"],
  "max-block-size": ["max-height"],
};

/**
 * A declared property, resolved to the atomic slots it writes. Anything not
 * recognised is its own slot, which keeps an unknown or plugin-authored
 * property comparable with itself and inert against everything else.
 */
export function expandProperty(property: string, direction: WritingDirection = "ltr"): string[] {
  const direct = EXPANSIONS[property];
  if (direct) return [...direct];

  const sides = LOGICAL_SIDES[direction];

  for (const box of ["padding", "margin", "scroll-margin", "scroll-padding"]) {
    const expanded = boxSides(sides, property, box);
    if (expanded) return expanded.map((side) => `${box}-${side}`);
  }

  const inset = boxSides(sides, property, "inset");
  if (inset) return [...inset];
  if (BOX_SIDES.includes(property as (typeof BOX_SIDES)[number])) return [property];

  for (const kind of BORDER_KINDS) {
    const expanded = borderSides(sides, property, kind);
    if (expanded) return expanded.map((side) => `border-${side}-${kind}`);
  }

  return [property];
}

function boxSides(
  sides: Record<string, readonly string[]>,
  property: string,
  box: string
): readonly string[] | null {
  if (property === box) return sides[""] ?? null;
  if (!property.startsWith(`${box}-`)) return null;
  return sides[property.slice(box.length + 1)] ?? null;
}

/** `border-width`, `border-inline-color`… arrive as `border-[side-]<kind>`. */
function borderSides(
  sides: Record<string, readonly string[]>,
  property: string,
  kind: string
): readonly string[] | null {
  if (!property.startsWith("border-") || !property.endsWith(`-${kind}`)) return null;
  const middle = property.slice("border-".length, property.length - kind.length - 1);
  return sides[middle] ?? null;
}
