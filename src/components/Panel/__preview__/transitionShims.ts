// Imported straight after the bridge shim, before any module that might ask
// `viewCacheState` whether this view is cached: it latches the answer on first
// read, so the correction has to be in place before then.
//
// The preview bridge answers every call with a truthy thenable, which
// `isViewCached()` would read as "this view is cached" — and a cached view skips
// the transition entirely. This page is the foreground view by definition.
const bridge: unknown = Reflect.get(window, "electron");
if (bridge && typeof bridge === "object") {
  const shimApp: unknown = Reflect.get(bridge, "app");
  if (shimApp && typeof shimApp === "object") {
    Reflect.set(
      bridge,
      "app",
      new Proxy(shimApp, {
        get: (target, key) => (key === "isViewCached" ? () => false : Reflect.get(target, key)),
      })
    );
  }
}
