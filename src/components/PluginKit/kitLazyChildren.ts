// Children a plugin hands over as a promise (a lazy tree node, a table row's
// sub-rows), held outside React so a render that asks again gets the same
// load rather than starting another. Each component instance owns its own
// scope, so two trees sharing a node never share a loader's result; within a
// scope a result is keyed by the parent itself, so a plugin that rebuilds a
// node gets its children loaded afresh. Settling bumps the scope's own
// version, so only the component that owns it re-renders.

import { useState, useSyncExternalStore } from "react";

export type LazyEntry<T> =
  | { status: "loading" }
  | { status: "done"; items: readonly T[] }
  | { status: "error"; message: string };

/** One component instance's cache and its change signal: see {@link useLazyScope}. */
export interface LazyScope {
  readonly byObject: WeakMap<object, LazyEntry<unknown>>;
  // A primitive parent (a string id used as the node) cannot key a WeakMap; a
  // bounded map keeps those from growing without end.
  readonly byPrimitive: Map<unknown, LazyEntry<unknown>>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly bump: () => void;
}

const PRIMITIVE_CAP = 2000;

export function createLazyScope(): LazyScope {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    byObject: new WeakMap(),
    byPrimitive: new Map(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
    bump: () => {
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * A scope for this component instance, and a revision that changes when one
 * of its loads settles or is forgotten. Another instance's loads never
 * re-render it.
 */
export function useLazyScope(): { scope: LazyScope; revision: number } {
  const [scope] = useState(createLazyScope);
  const revision = useSyncExternalStore(scope.subscribe, scope.getVersion, scope.getVersion);
  return { scope, revision };
}

function readEntry(scope: LazyScope, parent: unknown): LazyEntry<unknown> | undefined {
  return typeof parent === "object" && parent !== null
    ? scope.byObject.get(parent)
    : scope.byPrimitive.get(parent);
}

function writeEntry(scope: LazyScope, parent: unknown, entry: LazyEntry<unknown>): void {
  if (typeof parent === "object" && parent !== null) {
    scope.byObject.set(parent, entry);
    return;
  }
  scope.byPrimitive.delete(parent);
  scope.byPrimitive.set(parent, entry);
  if (scope.byPrimitive.size > PRIMITIVE_CAP) {
    const oldest = scope.byPrimitive.keys().next().value;
    scope.byPrimitive.delete(oldest);
  }
}

export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && error.message) return error.message;
  } catch {
    // A hostile error object; fall through to the generic message.
  }
  if (typeof error === "string" && error) return error;
  return "Couldn't load";
}

/** A thenable's `then`, or undefined; a getter that throws counts as none. */
function thenOf(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const then: unknown = Reflect.get(value, "then");
    return typeof then === "function" ? (...args) => Reflect.apply(then, value, args) : undefined;
  } catch {
    return undefined;
  }
}

function listOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value : [];
}

/** A load already started (or settled) for `parent`, without starting one. */
export function peekLazyChildren<T>(scope: LazyScope, parent: unknown): LazyEntry<T> | undefined {
  const entry = readEntry(scope, parent);
  if (!entry) return undefined;
  if (entry.status === "done") return { status: "done", items: listOf<T>(entry.items) };
  return entry;
}

/**
 * The children `load` gives for `parent`. An array comes back as is and is
 * not held, so a live getter is read afresh each time. A promise's state is
 * held, and its `load` runs again only after `forget`; one that settles
 * during the call comes back settled.
 */
export function readLazyChildren<T>(
  scope: LazyScope,
  parent: unknown,
  load: () => unknown
): LazyEntry<T> | null {
  const known = peekLazyChildren<T>(scope, parent);
  if (known) return known;
  let result: unknown;
  try {
    result = load();
  } catch (error) {
    const failed: LazyEntry<T> = { status: "error", message: errorMessage(error) };
    writeEntry(scope, parent, failed);
    return failed;
  }
  if (Array.isArray(result)) return { status: "done", items: result };
  const then = thenOf(result);
  if (!then) return null;
  // This load's own entry: a settlement after a Retry started another load is
  // the old request's, and is dropped.
  const loading: LazyEntry<unknown> = { status: "loading" };
  writeEntry(scope, parent, loading);
  try {
    then(
      (items: unknown) => {
        if (readEntry(scope, parent) !== loading) return;
        writeEntry(scope, parent, { status: "done", items: listOf(items) });
        scope.bump();
      },
      (error: unknown) => {
        if (readEntry(scope, parent) !== loading) return;
        writeEntry(scope, parent, { status: "error", message: errorMessage(error) });
        scope.bump();
      }
    );
  } catch (error) {
    // A `then` that settled before it threw keeps what it settled with.
    if (readEntry(scope, parent) === loading) {
      writeEntry(scope, parent, { status: "error", message: errorMessage(error) });
    }
  }
  return peekLazyChildren<T>(scope, parent) ?? { status: "loading" };
}

/** Drops what is held for `parent`, so the next read loads it again (Retry). */
export function forgetLazyChildren(scope: LazyScope, parent: unknown): void {
  if (typeof parent === "object" && parent !== null) scope.byObject.delete(parent);
  else scope.byPrimitive.delete(parent);
  scope.bump();
}
