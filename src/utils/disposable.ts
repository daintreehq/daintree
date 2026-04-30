/**
 * Lifecycle primitives for resource ownership. Modeled on VS Code's
 * `src/vs/base/common/lifecycle.ts` — a `DisposableStore` owns a set of
 * `IDisposable` entries and releases them as a group. Registering a
 * subscription and its cleanup becomes one inseparable operation, so
 * forgetting to clean up becomes a type error at the call site rather
 * than a runtime leak discovered later.
 */

export interface IDisposable {
  dispose(): void;
}

/**
 * Wraps a plain cleanup function as an IDisposable. The wrapped function
 * is invoked at most once; subsequent `dispose()` calls are no-ops.
 */
export function toDisposable(fn: () => void): IDisposable {
  let isDisposed = false;
  return {
    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;
      fn();
    },
  };
}

/**
 * Container for `IDisposable` entries. Disposal releases every registered
 * entry in reverse registration order (LIFO) so teardown matches setup
 * ordering — the last resource wired up is the first one torn down.
 *
 * - `add(d)` returns `d` so callers can assign in a single expression:
 *   `const sub = store.add(toDisposable(source.subscribe(...)));`
 * - `clear()` releases current entries and leaves the store usable.
 * - `dispose()` releases entries and marks the store permanently dead;
 *   later `add()` calls warn and leak rather than silently swallowing
 *   the registration, matching VS Code's behavior.
 */
export class DisposableStore implements IDisposable {
  private readonly disposables = new Set<IDisposable>();
  private isDisposed = false;

  add<T extends IDisposable>(disposable: T): T {
    if (this.isDisposed) {
      console.warn(
        "[DisposableStore] add() called after dispose(); registration ignored and will leak.",
        disposable
      );
      return disposable;
    }
    this.disposables.add(disposable);
    return disposable;
  }

  clear(): void {
    if (this.disposables.size === 0) return;
    const entries = Array.from(this.disposables).reverse();
    this.disposables.clear();
    for (const entry of entries) entry.dispose();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.clear();
  }
}
