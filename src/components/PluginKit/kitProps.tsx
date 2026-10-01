import { isValidElement, useContext, type ReactNode } from "react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleOwner";
import { KIT_FOCUS_SCOPE_ATTRIBUTE, KitFocusScopeContext, usePluginKitOwner } from "./kitScope";
import { warnPluginAuthor } from "./kitDiagnostics";

// Every adapter here narrows its props rather than trusting them: a plugin
// view is as often hand-written JavaScript as TypeScript, and the public props
// are a contract the host components behind them must not leak past.

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

// `Reflect.get` rather than a cast to a record: plugin objects are read one
// field at a time and each field is narrowed where it is used.
export function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

export function fn<T extends (...args: never[]) => unknown>(value: T | undefined): T | undefined {
  return typeof value === "function" ? value : undefined;
}

// Numbers from untyped JS, by what the prop means. Anything that is not a
// finite number in range is unset, and the component's default applies.

/** A strictly positive amount: a dimension, a step. */
export function positive(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max
    ? value
    : undefined;
}

/** A duration in ms, where zero means at once. */
export function durationMs(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

/** A limit on how many (characters, items): whole, and zero allows none. */
export function wholeLimit(value: unknown, max: number): number | undefined {
  const n = durationMs(value, max);
  return n === undefined ? undefined : Math.floor(n);
}

/** How many rows or items to show: whole, and never fewer than one. */
export function rowCount(value: unknown, max: number): number | undefined {
  const n = positive(value, max);
  return n === undefined ? undefined : Math.max(1, Math.round(n));
}

// Deep enough for any real fragment list. An array inside itself is dropped
// at once, and the budget bounds the work an array shared many times over can
// make, so malformed content never stalls a render.
const MAX_NODE_DEPTH = 32;
const NODE_VISIT_BUDGET = 100_000;
let warnedPlainObject = false;

interface NodeWalk {
  path: Set<unknown[]>;
  visits: number;
}

function normalizeNode(value: unknown, depth: number, walk: NodeWalk): ReactNode {
  if (value === undefined || value === null || typeof value === "boolean" || value === "") {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || isValidElement(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_NODE_DEPTH || walk.path.has(value)) return null;
    walk.visits += value.length;
    if (walk.visits > NODE_VISIT_BUDGET) return null;
    walk.path.add(value);
    const out = value.map((entry) => normalizeNode(entry, depth + 1, walk));
    walk.path.delete(value);
    return out.some((entry) => entry !== null) ? out : null;
  }
  if (!warnedPlainObject) {
    warnedPlainObject = true;
    warnPluginAuthor("A plain object was passed where content goes; it renders nothing.");
  }
  return null;
}

/**
 * A node prop from untyped JS, narrowed to what React renders without
 * throwing: text, numbers, elements and arrays of them. A plain object (the
 * usual JS slip) is dropped rather than crashing the view. Nothing to show
 * (`false`, `""`, `[]`, `[null]`) comes back as `null`, so presence and
 * rendering never disagree: see {@link hasContent}. An element is opaque; one
 * whose component renders null still counts.
 */
export function node(value: unknown): ReactNode {
  return normalizeNode(value, 0, { path: new Set(), visits: 0 });
}

/** {@link node}, or `undefined` when there is nothing to show. */
export function content(value: unknown): ReactNode {
  const out = node(value);
  return out === null ? undefined : out;
}

/**
 * The owner stamp for an element a kit overlay portals out of the view, so
 * diagnostics attribute what happens inside it to the plugin (empty outside a
 * plugin view), and the composite controls it belongs to, for their blur.
 */
export function useKitOwnerAttributes(): Record<string, string> {
  const owner = usePluginKitOwner();
  const focusScope = useContext(KitFocusScopeContext);
  return {
    ...(owner ? { [PLUGIN_STYLE_OWNER_ATTRIBUTE]: owner } : {}),
    ...(focusScope ? { [KIT_FOCUS_SCOPE_ATTRIBUTE]: focusScope } : {}),
  };
}

/**
 * Plugin content inside a host overlay (tooltip body, dialog body) portals out
 * of the view's style root, where the plugin's compiled classes are scoped.
 * Re-marking the subtree keeps them applying, and names the owning plugin as
 * the view's own root does; the overlay chrome stays host-owned.
 */
export function PluginStyleScope({
  children,
  block,
  className,
}: {
  children: ReactNode;
  block?: boolean;
  className?: string;
}) {
  const scope = { [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "", ...useKitOwnerAttributes() };
  return block ? (
    <div {...scope} className={className}>
      {children}
    </div>
  ) : (
    <span {...scope}>{children}</span>
  );
}

/** Whether {@link node} would draw anything: `0` does, `[]` and `[null]` do not. */
/**
 * {@link content} for an inline slot the host renders outside the view (a
 * dialog title or hint, a tooltip): markup is wrapped in a
 * {@link PluginStyleScope} so the plugin's classes still apply; text needs no
 * wrapper.
 */
export function scopedContent(value: unknown): ReactNode {
  const out = content(value);
  if (out === undefined || typeof out === "string" || typeof out === "number") return out;
  return <PluginStyleScope>{out}</PluginStyleScope>;
}

export function hasContent(value: unknown): boolean {
  return node(value) !== null;
}

export const SIDES = ["top", "right", "bottom", "left"] as const;
export const ALIGNS = ["start", "center", "end"] as const;

/**
 * The DOM props a kit control forwards: `id`, `title`, `tabIndex`, `role`,
 * `style`, `aria-*`/`data-*` scalars, `on*` handlers and `ref`. That set is
 * what a Radix `asChild` trigger hands its child, so a kit Button can be a
 * menu or tooltip trigger, and nothing like `dangerouslySetInnerHTML` or a
 * host-only prop (`asChild`, `variant` spellings) gets through.
 */
/**
 * The root attributes a kit component with no full DOM props forwards: scalar
 * `data-*` and a string `id`, plus scalar `aria-*` when `aria` is set. The
 * component spreads them first, so an attribute it sets itself wins.
 */
export function pickRootProps(
  props: object,
  options: { aria?: boolean } = {}
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "id") {
      if (typeof value === "string" && value !== "") out[key] = value;
    } else if (key.startsWith("data-") || (options.aria === true && key.startsWith("aria-"))) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out[key] = value;
      }
    }
  }
  return out;
}

export function pickDomProps(props: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("aria-") || key.startsWith("data-")) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out[key] = value;
      }
    } else if (/^on[A-Z]/.test(key)) {
      if (typeof value === "function") out[key] = value;
    } else if (key === "ref") {
      if (typeof value === "function" || (typeof value === "object" && value !== null)) {
        out[key] = value;
      }
    } else if (key === "id" || key === "title" || key === "role") {
      if (typeof value === "string") out[key] = value;
    } else if (key === "tabIndex") {
      if (typeof value === "number" && Number.isInteger(value)) out[key] = value;
    } else if (key === "style") {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) out[key] = value;
    }
  }
  return out;
}
