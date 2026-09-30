import { isValidElement, type ReactNode } from "react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleContract";
import { usePluginKitOwner } from "./kitScope";

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

/** A node from untyped JS that React can render: text or an element. */
export function asNode(value: unknown): ReactNode {
  if (typeof value === "string" || typeof value === "number" || isValidElement(value)) {
    return value;
  }
  return undefined;
}

export function fn<T extends (...args: never[]) => unknown>(value: T | undefined): T | undefined {
  return typeof value === "function" ? value : undefined;
}

export function positive(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max
    ? value
    : undefined;
}

/**
 * A node prop from untyped JS, narrowed to what React renders without
 * throwing: text, numbers, elements and arrays of them. A plain object (the
 * usual JS slip) is dropped rather than crashing the view.
 */
export function node(value: unknown): ReactNode {
  if (value === undefined || value === null || typeof value === "boolean") return null;
  if (typeof value === "string" || typeof value === "number" || isValidElement(value)) {
    return value;
  }
  if (Array.isArray(value)) return value.map(node);
  return null;
}

/** {@link node}, or `undefined` when there is nothing to show. */
export function content(value: unknown): ReactNode {
  return hasContent(value) ? node(value) : undefined;
}

/**
 * The owner stamp for an element a kit overlay portals out of the view, so
 * diagnostics attribute what happens inside it to the plugin. Empty outside a
 * plugin view.
 */
export function useKitOwnerAttributes(): Record<string, string> {
  const owner = usePluginKitOwner();
  return owner ? { [PLUGIN_STYLE_OWNER_ATTRIBUTE]: owner } : {};
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

export function hasContent(node: unknown): boolean {
  return node !== undefined && node !== null && node !== false && node !== true && node !== "";
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
