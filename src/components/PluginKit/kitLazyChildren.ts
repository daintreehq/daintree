// Children a plugin hands over as a promise (a lazy tree node, a table row's
// sub-rows), held outside React so a render that asks again gets the same
// load rather than starting another. Each component instance owns its own
// scope, so two trees sharing a node never share a loader's result; within a
// scope a result is keyed by the parent itself, so a plugin that rebuilds a
// node gets its children loaded afresh. Settling bumps one version that the
// kit's lazy components subscribe to, so whichever one is waiting re-renders.

export type LazyEntry<T> =
  | { status: "loading" }
  | { status: "done"; items: readonly T[] }
  | { status: "error"; message: string };

/** One component instance's cache. Create it once per instance (`useState`). */
export interface LazyScope {
  readonly byObject: WeakMap<object, LazyEntry<unknown>>;
  // A primitive parent (a string id used as the node) cannot key a WeakMap; a
  // bounded map keeps those from growing without end.
  readonly byPrimitive: Map<unknown, LazyEntry<unknown>>;
}

const PRIMITIVE_CAP = 2000;

export function createLazyScope(): LazyScope {
  return { byObject: new WeakMap(), byPrimitive: new Map() };
}

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeLazyChildren(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function lazyChildrenVersion(): number {
  return version;
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
 * The children `load` gives for `parent`: at once for an array, else the
 * state of the one load started for it. `load` runs again only after `forget`.
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
        bump();
      },
      (error: unknown) => {
        if (readEntry(scope, parent) !== loading) return;
        writeEntry(scope, parent, { status: "error", message: errorMessage(error) });
        bump();
      }
    );
  } catch (error) {
    const failed: LazyEntry<T> = { status: "error", message: errorMessage(error) };
    writeEntry(scope, parent, failed);
    return failed;
  }
  return { status: "loading" };
}

/** Drops what is held for `parent`, so the next read loads it again (Retry). */
export function forgetLazyChildren(scope: LazyScope, parent: unknown): void {
  if (typeof parent === "object" && parent !== null) scope.byObject.delete(parent);
  else scope.byPrimitive.delete(parent);
  bump();
}
