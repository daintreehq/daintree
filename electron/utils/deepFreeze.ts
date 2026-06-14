/**
 * Recursively `Object.freeze` a value and every nested object/array it reaches.
 *
 * Main-process counterpart to the renderer's `deepFreeze` in `ActionService`
 * (issue #9569). Used to enforce immutability invariants on shared, parsed data
 * — e.g. a plugin manifest stored on `LoadedPlugin.manifest` and read across the
 * whole `PluginService` lifecycle. A shallow `Object.freeze` leaves nested
 * `contributes.*` arrays writable, so an accidental in-place mutation of a
 * declared contribution would silently poison the shared record.
 *
 * DEV-only: a no-op when `NODE_ENV === "production"`, so the invariant fails
 * loudly in dev/test (strict-mode writes throw) without risking a production
 * crash on some untyped mutation path. The `seen` guard keeps it stack-safe
 * against cyclic input (plugin-supplied data is untrusted).
 */
export function deepFreeze(val: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (process.env.NODE_ENV === "production" || val === null || typeof val !== "object") {
    return;
  }
  if (seen.has(val)) return;
  seen.add(val);
  Object.freeze(val);
  for (const child of Object.values(val as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
}
