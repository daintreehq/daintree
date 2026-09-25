const PREFIX = "@daintreehq/plugin-sdk/react:";

/**
 * Counters for one {@link ViewScope}. They describe what the scope itself
 * tracked and nothing else: a resource the view created without registering it
 * is invisible here, so `active: 0` proves nothing about what survived an
 * unmount — a heap snapshot is the tool for that.
 */
export interface ViewScopeStats {
  /** Registrations still held: not yet released, cancelled, or fired. */
  readonly active: number;
  /** Cleanups that ran without throwing, including early cancellations and late registrations released on arrival. A one-shot that fired on its own is not counted. */
  readonly released: number;
  /** Cleanups that threw. Each is logged; the rest of the scope is still released. */
  readonly cleanupErrors: number;
  /** Registrations attempted after the scope was disposed. Each is released (or never started) on arrival. */
  readonly lateRegistrations: number;
}

export interface ViewScopeOptions {
  /**
   * Called once, after the scope's first disposal has released everything it
   * held — including disposal that happens inside `createViewScope` because the
   * signal was already aborted. Opt-in rather than gated on a build flag: a
   * plugin's panel is a production Vite library build even under
   * `daintree-plugin dev`, so neither `process.env.NODE_ENV` nor
   * `import.meta.env.DEV` says whether anyone is debugging.
   */
  readonly onReport?: (stats: ViewScopeStats) => void;
}

/**
 * A bag of view-owned resources released together. Every method is safe to
 * call after disposal: the resource is released (or never started) on the
 * spot and counted in `lateRegistrations`, so an async continuation that
 * outlives its view attempt cannot leak through the scope.
 *
 * Methods that start something return an idempotent function that releases
 * it early; one-shots (a fired timeout or frame, a `once` listener) forget
 * their registration before the callback runs, so the scope only ever holds
 * what is still live.
 */
export interface ViewScope {
  /** True once disposal has started. */
  readonly disposed: boolean;
  /**
   * Aborts when the scope is disposed, before any tracked resource is
   * released. Pass it to `fetch` and other signal-aware APIs; work tied to it
   * directly is not counted in {@link ViewScope.stats}.
   */
  readonly signal: AbortSignal;
  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (this: Window, event: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): () => void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (this: Document, event: DocumentEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): () => void;
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (this: HTMLElement, event: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): () => void;
  /**
   * `addEventListener` whose removal is owned by the scope. Each call is an
   * independent subscription, even for a listener already registered. A
   * `signal` in `options` still unsubscribes early, and an already-aborted one
   * subscribes nothing.
   */
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): () => void;
  setTimeout<A extends unknown[]>(
    callback: (...args: A) => void,
    ms?: number,
    ...args: A
  ): () => void;
  setInterval<A extends unknown[]>(
    callback: (...args: A) => void,
    ms?: number,
    ...args: A
  ): () => void;
  requestAnimationFrame(callback: FrameRequestCallback): () => void;
  /**
   * Adopt a `ResizeObserver`, `MutationObserver`, `IntersectionObserver` or
   * anything else with `disconnect()`, returned as given. Start it before
   * adopting it: a disposed scope disconnects what it adopts on arrival, and an
   * observer started after that would escape the scope. To release one early,
   * register it with {@link ViewScope.add} instead and call the function that
   * returns.
   */
  observe<T extends { disconnect(): void }>(observer: T): T;
  /** Adopt a dedicated `Worker` (anything with `terminate()`). */
  worker<T extends { terminate(): void }>(worker: T): T;
  /** `URL.createObjectURL` whose `revokeObjectURL` is owned by the scope. */
  objectURL(object: Blob | MediaSource): string;
  /**
   * Adopt a WebGL context from a canvas the view owns. Disposal calls
   * `WEBGL_lose_context.loseContext()` when the extension is available and the
   * context is not already lost, so the GPU allocation goes now rather than at
   * a later GC — Chromium evicts the oldest context once a renderer holds
   * about sixteen.
   */
  webgl<T extends WebGLRenderingContext | WebGL2RenderingContext>(gl: T): T;
  /** Register any synchronous cleanup. The returned function runs it early. */
  add(disposer: () => void): () => void;
  /**
   * Release everything, newest first. Idempotent, never throws: a cleanup that
   * throws is logged and counted, and the rest still run.
   */
  dispose(): void;
  stats(): ViewScopeStats;
}

interface Entry {
  cleanup: (() => void) | null;
}

const noop = () => {};

function loseContext(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  if (gl.isContextLost()) return;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

/**
 * Tie view-owned resources to one mount attempt of a plugin panel view. Pass
 * the view's `disposeSignal`: the scope disposes when it aborts, and when the
 * owning effect calls `dispose()`, whichever comes first.
 *
 * ```tsx
 * useEffect(() => {
 *   const scope = createViewScope(disposeSignal);
 *   scope.listen(window, "resize", onResize);
 *   const observer = new ResizeObserver(onBoxChange);
 *   observer.observe(el);
 *   scope.observe(observer);
 *   return scope.dispose;
 * }, [disposeSignal]);
 * ```
 *
 * Create a fresh scope in each effect setup; a disposed scope cannot be
 * reopened. The scope drops everything it captured once disposed: a stale
 * cancel function retains nothing but the scope's counters, and a stale scope
 * adds only its aborted `signal`, with that signal's reason and listeners.
 */
export function createViewScope(signal: AbortSignal, options?: ViewScopeOptions): ViewScope {
  // Cleared on teardown so a retained cancel function, which reaches this
  // context, does not keep the aborted signal's listeners and reason alive.
  let controller: AbortController | null = new AbortController();
  const scopeSignal = controller.signal;
  let entries: Set<Entry> | null = new Set();
  let upstream: AbortSignal | null = signal;
  let onReport = options?.onReport;
  let released = 0;
  let cleanupErrors = 0;
  let lateRegistrations = 0;
  let warnedLate = false;
  let runningCleanups = 0;
  let reportPending = false;

  const stats = (): ViewScopeStats => ({
    active: entries?.size ?? 0,
    released,
    cleanupErrors,
    lateRegistrations,
  });

  const deliverReport = (): void => {
    reportPending = false;
    const report = onReport;
    onReport = undefined;
    if (!report) return;
    try {
      report(stats());
    } catch (error) {
      console.error(`${PREFIX} a view-scope onReport callback threw.`, error);
    }
  };

  // A cleanup can dispose the scope and then throw; the report waits for the
  // outermost cleanup to finish so its outcome is counted.
  const runCleanup = (cleanup: () => void): void => {
    runningCleanups++;
    try {
      cleanup();
      released++;
    } catch (error) {
      cleanupErrors++;
      console.error(
        `${PREFIX} a view-scope cleanup threw; the scope's other resources were still released.`,
        error
      );
    } finally {
      runningCleanups--;
      if (runningCleanups === 0 && reportPending) deliverReport();
    }
  };

  const noteLate = (): void => {
    lateRegistrations++;
    if (warnedLate) return;
    warnedLate = true;
    console.warn(
      `${PREFIX} a resource was registered on a view scope after it was disposed and was released immediately. Check scope.signal.aborted before starting work that can outlive the view.`
    );
  };

  const track = (cleanup: () => void): Entry => {
    const entry: Entry = { cleanup };
    entries?.add(entry);
    return entry;
  };

  // Forget a registration without counting it as a release: a one-shot that
  // fired, or a listener its caller's own signal removed.
  const finish = (entry: Entry): void => {
    const cleanup = entry.cleanup;
    if (!cleanup) return;
    entry.cleanup = null;
    entries?.delete(entry);
    cleanup();
  };

  const settle = (entry: Entry): void => {
    entry.cleanup = null;
    entries?.delete(entry);
  };

  const release = (entry: Entry): void => {
    const cleanup = entry.cleanup;
    if (!cleanup) return;
    settle(entry);
    runCleanup(cleanup);
  };

  // Built here rather than inline so a retained cancel function's closure holds
  // only the entry: V8 shares one context between the closures created in a
  // call, so an inline arrow would pin the target, listener or timer arguments.
  const canceller =
    (entry: Entry): (() => void) =>
    () =>
      release(entry);

  const adopt = (cleanup: () => void): (() => void) => {
    if (!entries) {
      noteLate();
      runCleanup(cleanup);
      return noop;
    }
    return canceller(track(cleanup));
  };

  const teardown = (reason?: unknown): void => {
    const drained = entries;
    if (!drained) return;
    entries = null;
    upstream?.removeEventListener("abort", onUpstreamAbort);
    upstream = null;
    const aborting = controller;
    controller = null;
    aborting?.abort(reason);

    const pending = [...drained].reverse();
    drained.clear();
    for (const entry of pending) {
      const cleanup = entry.cleanup;
      if (!cleanup) continue;
      entry.cleanup = null;
      runCleanup(cleanup);
    }

    reportPending = true;
    if (runningCleanups === 0) deliverReport();
  };

  // Reads `upstream` rather than the `signal` parameter so no closure keeps the
  // host's signal reachable once the scope has let go of it.
  function onUpstreamAbort(): void {
    teardown(upstream?.reason);
  }

  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    listenOptions?: boolean | AddEventListenerOptions
  ): (() => void) => {
    if (!entries) {
      noteLate();
      return noop;
    }
    const opts = typeof listenOptions === "object" && listenOptions !== null ? listenOptions : {};
    const capture = typeof listenOptions === "boolean" ? listenOptions : opts.capture === true;
    const once = opts.once === true;
    const callerSignal = opts.signal;
    if (callerSignal?.aborted) return noop;

    const nativeOptions: AddEventListenerOptions = { capture };
    if (opts.passive !== undefined) nativeOptions.passive = opts.passive;

    let entry: Entry | null = null;
    // The caller's signal is checked here as well as through its abort event:
    // a native signal-backed listener is removed before any abort handler runs,
    // so an earlier handler that dispatches this event must not reach it.
    const wrapper = function (this: EventTarget, event: Event): void {
      if (callerSignal?.aborted) {
        if (entry) finish(entry);
        return;
      }
      if (once && entry) finish(entry);
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    };
    const onCallerAbort = (): void => {
      if (entry) finish(entry);
    };

    target.addEventListener(type, wrapper, nativeOptions);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    entry = track(() => {
      target.removeEventListener(type, wrapper, capture);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    });
    return canceller(entry);
  };

  const timer = <A extends unknown[]>(
    repeat: boolean,
    callback: (...args: A) => void,
    ms: number | undefined,
    args: A
  ): (() => void) => {
    if (!entries) {
      noteLate();
      return noop;
    }
    let entry: Entry | null = null;
    const id = repeat
      ? setInterval(() => callback(...args), ms)
      : setTimeout(() => {
          if (entry) settle(entry);
          callback(...args);
        }, ms);
    entry = track(() => (repeat ? clearInterval(id) : clearTimeout(id)));
    return canceller(entry);
  };

  const scope: ViewScope = {
    get disposed() {
      return entries === null;
    },
    signal: scopeSignal,
    listen: listen as ViewScope["listen"],
    setTimeout: (callback, ms, ...args) => timer(false, callback, ms, args),
    setInterval: (callback, ms, ...args) => timer(true, callback, ms, args),
    requestAnimationFrame(callback) {
      if (!entries) {
        noteLate();
        return noop;
      }
      let entry: Entry | null = null;
      const id = requestAnimationFrame((time) => {
        if (entry) settle(entry);
        callback(time);
      });
      entry = track(() => cancelAnimationFrame(id));
      return canceller(entry);
    },
    observe(observer) {
      adopt(() => observer.disconnect());
      return observer;
    },
    worker(worker) {
      adopt(() => worker.terminate());
      return worker;
    },
    objectURL(object) {
      const url = URL.createObjectURL(object);
      adopt(() => URL.revokeObjectURL(url));
      return url;
    },
    webgl(gl) {
      adopt(() => loseContext(gl));
      return gl;
    },
    add: (disposer) => adopt(disposer),
    dispose: () => teardown(),
    stats,
  };

  if (signal.aborted) teardown(signal.reason);
  else signal.addEventListener("abort", onUpstreamAbort, { once: true });
  return scope;
}
