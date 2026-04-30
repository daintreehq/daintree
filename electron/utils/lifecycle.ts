/**
 * Disposable lifecycle primitives, modeled on VS Code's
 * `vs/base/common/lifecycle.ts` (MIT-licensed). Trimmed to the subset this
 * codebase actually consumes: a small `IDisposable` interface, a `toDisposable`
 * adapter for legacy `() => void` cleanups, a `DisposableStore` aggregate, a
 * single-slot `MutableDisposable`, and a `Disposable` base class.
 *
 * The shape of `IDisposable` is structurally compatible with `node-pty`'s
 * `IDisposable` type — they never appear in the same import scope, but
 * structural compatibility means handles obtained from node-pty can be added
 * directly to a store without extra wrapping.
 */

export interface IDisposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: fn };
}

export class DisposableStore implements IDisposable {
  private readonly _disposables = new Set<IDisposable>();
  private _isDisposed = false;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  add<T extends IDisposable>(o: T): T {
    if (this._isDisposed) {
      console.error(
        "[lifecycle] DisposableStore.add() called after dispose — disposing immediately to avoid leak"
      );
      try {
        o.dispose();
      } catch {
        /* swallow — late teardown */
      }
      return o;
    }
    this._disposables.add(o);
    return o;
  }

  /** Dispose every registered child. Safe to call multiple times. */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    // Snapshot before iteration so a child's dispose() can mutate the Set
    // (e.g. by disposing a sibling that was registered here) without skipping
    // entries via in-flight Set iteration semantics.
    const items = Array.from(this._disposables);
    this._disposables.clear();
    for (const d of items) {
      try {
        d.dispose();
      } catch {
        /* swallow — mirrors WindowRegistry.unregister() error handling */
      }
    }
  }

  /** Dispose all children but keep the store usable for new registrations. */
  clear(): void {
    const items = Array.from(this._disposables);
    this._disposables.clear();
    for (const d of items) {
      try {
        d.dispose();
      } catch {
        /* swallow */
      }
    }
  }

  get size(): number {
    return this._disposables.size;
  }
}

export class MutableDisposable<T extends IDisposable = IDisposable> implements IDisposable {
  private _value: T | undefined;
  private _isDisposed = false;

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value;
  }

  set value(newValue: T | undefined) {
    if (this._isDisposed) {
      // Container is dead — dispose the incoming value immediately so callers
      // can't accidentally retain a resource by assigning into a torn-down slot.
      if (newValue !== undefined) {
        try {
          newValue.dispose();
        } catch {
          /* swallow */
        }
      }
      return;
    }
    if (this._value === newValue) return;
    if (this._value !== undefined) {
      try {
        this._value.dispose();
      } catch {
        /* swallow */
      }
    }
    this._value = newValue;
  }

  clear(): void {
    this.value = undefined;
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    if (this._value !== undefined) {
      try {
        this._value.dispose();
      } catch {
        /* swallow */
      }
      this._value = undefined;
    }
  }
}

export abstract class Disposable implements IDisposable {
  protected readonly _store = new DisposableStore();

  protected _register<T extends IDisposable>(o: T): T {
    return this._store.add(o);
  }

  dispose(): void {
    this._store.dispose();
  }
}
