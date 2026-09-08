import { vi, type Mock } from "vitest";

/**
 * The launch outcomes execa 9.6.1 actually produces, verified against the
 * installed package. None of them is a synchronous throw: `execa()` converts
 * every broken command into an async rejection, and its early-error path hands
 * back a real `ChildProcess` that never emits anything at all.
 */
export type ChildBehaviour =
  /** A detached GUI editor: 'spawn' fires and the promise outlives us. */
  | "spawned"
  /** Exec succeeded, the process then failed. Still a launch — see #12327. */
  | "spawned-then-exit"
  /** Missing or non-executable binary: 'error' fires, no 'spawn', rejects. */
  | "enoent"
  /** execa's early-error dummy child: no events whatsoever, still rejects. */
  | "early-error"
  /** Exited 0 before anything observed 'spawn'. */
  | "resolved"
  /** Nothing happens until the test drives it — see `ChildDouble` controls. */
  | "manual";

export interface ChildDouble {
  unref: Mock;
  catch: Mock;
  then: Mock;
  once: Mock;
  on: Mock;
  listenerCount: (event: string) => number;
  /** Drive a "manual" child from the test, one channel at a time. */
  emitSpawn: () => void;
  rejectLaunch: (error?: Error) => void;
}

export function makeChildDouble(behaviour: ChildBehaviour): ChildDouble {
  const listeners = new Map<string, Set<() => void>>();
  // A plain registry rather than an EventEmitter: emitting 'error' with no
  // listener would throw synchronously, which is the very failure shape these
  // doubles exist to rule out.
  const once = new WeakSet<() => void>();
  const register = (event: string, listener: () => void, removeAfterCall: boolean) => {
    const registered = listeners.get(event) ?? new Set<() => void>();
    registered.add(listener);
    listeners.set(event, registered);
    if (removeAfterCall) once.add(listener);
  };
  const emit = (event: string) => {
    const registered = listeners.get(event);
    if (!registered) return;
    for (const listener of [...registered]) {
      if (once.has(listener)) registered.delete(listener);
      listener();
    }
  };

  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const child: ChildDouble = {
    unref: vi.fn(),
    catch: vi.fn((onRejected: (reason: unknown) => unknown) => promise.catch(onRejected)),
    then: vi.fn((onFulfilled?: () => unknown, onRejected?: () => unknown) =>
      promise.then(onFulfilled, onRejected)
    ),
    once: vi.fn((event: string, listener: () => void) => {
      register(event, listener, true);
      return child;
    }),
    // Present so an event-only implementation written against `on` registers
    // here and hangs, rather than dying on a missing method and looking fixed.
    on: vi.fn((event: string, listener: () => void) => {
      register(event, listener, false);
      return child;
    }),
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    emitSpawn: () => emit("spawn"),
    rejectLaunch: (error = new Error("spawn ENOENT")) => rejectPromise(error),
  };

  // Deferred by one microtask so the caller has attached its listeners first —
  // the same ordering the real package produces, since execa() returns before
  // the OS has answered.
  queueMicrotask(() => {
    switch (behaviour) {
      case "spawned":
        emit("spawn");
        break;
      case "spawned-then-exit":
        emit("spawn");
        rejectPromise(new Error("Command failed with exit code 1"));
        break;
      case "enoent":
        emit("error");
        rejectPromise(new Error("spawn ENOENT"));
        break;
      case "early-error":
        rejectPromise(new Error("The `uid` option is invalid"));
        break;
      case "resolved":
        resolvePromise();
        break;
      case "manual":
        break;
    }
  });

  return child;
}

/**
 * Hand one child per `execa()` call. The last behaviour repeats, so a single
 * entry covers however many candidates the fallback chain tries.
 */
export function mockExecaChildren(execa: Mock, behaviours: ChildBehaviour[]): ChildDouble[] {
  const created: ChildDouble[] = [];
  execa.mockImplementation(() => {
    const behaviour = behaviours[Math.min(created.length, behaviours.length - 1)]!;
    const child = makeChildDouble(behaviour);
    created.push(child);
    return child;
  });
  return created;
}
