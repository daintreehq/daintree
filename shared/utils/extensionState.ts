/**
 * The rules a plugin panel's `persistState` write is held to, in one place.
 *
 * The app's panel store applies them to the real panel record and the SDK's
 * panel preview applies them to its mock one, so a view behaves the same in a
 * preview as it does in Daintree: the same merge, the same rejection of state
 * that cannot round-trip, the same 64KB cap and the same version stamping. Pure
 * and browser-safe — nothing here logs, stores or imports a runtime.
 */

/**
 * Ceiling on one panel's persisted extension state, measured as serialized
 * JSON bytes.
 *
 * `extensionState` rides the panel record into the project's `state.json` on
 * every layout save, so an unbounded bag is an unbounded write amplification on
 * a path the user never sees. 64KB is far above what the state this exists for
 * costs — a file browser's expanded-path set, selection and sort is a few
 * hundred bytes even for a deep tree — and far below anything that would make a
 * layout save noticeable. A plugin wanting to persist more than this wants
 * `host.storage`, which is per-plugin, off the layout path, and unbounded.
 */
export const MAX_EXTENSION_STATE_BYTES = 64 * 1024;

/**
 * Re-read a bag from its own serialization.
 *
 * The input is always `JSON.stringify` of an object the caller built, so the
 * result is an object — narrowed by check rather than asserted, because the
 * whole point of the round trip is that nothing here trusts its input.
 */
export function parseCanonical(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null) return {};
  // Rebuilt entry by entry rather than handed back directly: `fromEntries`
  // defines own data properties, so a bag containing a literal `__proto__` key
  // stays a key instead of quietly re-pointing the object's prototype.
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * `JSON.stringify`, with both of its failure modes collapsed to `undefined`.
 *
 * It throws on a cyclic value, a BigInt or a throwing `toJSON`, and it also
 * *returns* `undefined` outright for a value whose `toJSON` returns undefined —
 * which is not an exception and would crash the caller rather than being
 * rejected.
 */
export function serializeOrUndefined(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : undefined;
  } catch {
    return undefined;
  }
}

// Byte length, not `String.length`: the latter counts UTF-16 code units, so
// ~30k CJK characters would measure as well under a 64KB cap while occupying
// ~90KB once encoded.
export function byteLength(serialized: string): number {
  return new TextEncoder().encode(serialized).length;
}

/** Merge a patch into a bag, with `undefined` removing the key. */
export function mergePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const draft: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete draft[key];
    else draft[key] = value;
  }
  return draft;
}

/**
 * Whether a bag that serializes to `bytes` may replace one of `currentBytes`.
 *
 * A bag that is somehow already over the cap — legacy state, or spawn arguments
 * that never passed through here — must still be shrinkable, or the writer is
 * locked out of the only operation that could fix it.
 */
export function withinCap(bytes: number, currentBytes: () => number): boolean {
  if (bytes <= MAX_EXTENSION_STATE_BYTES) return true;
  const current = currentBytes();
  return current > MAX_EXTENSION_STATE_BYTES && bytes < current;
}

/** What committing an accepted bag does to the stored record. */
export type ExtensionStateCommit =
  /** The record already holds this bag at this version: nothing to write. */
  | { kind: "unchanged" }
  /** Same bytes, but the version has to move. */
  | { kind: "restamp"; version: number | undefined }
  /** A new bag, stored canonically, at `version`. */
  | { kind: "replace"; state: Record<string, unknown>; version: number | undefined };

/**
 * Compare an accepted bag against what is stored and decide what to write.
 *
 * Shared by every write policy: what differs between them is who may write,
 * what they may write, and whether the version moves — not how the result is
 * stored.
 */
export function commitExtensionState(
  currentSerialized: string | undefined,
  serialized: string,
  currentVersion: number | undefined,
  nextVersion: number | undefined
): ExtensionStateCommit {
  // A view that re-persists identical state on every render — the common
  // shape when the state is derived — must not churn the store or schedule
  // a layout save. Compared on the canonical form, because the patch carries
  // fresh object identities every time.
  if (currentSerialized === serialized) {
    // ...unless the VERSION still has to move. A migration whose result is
    // byte-identical to what it read is a real migration — the plugin has
    // confirmed the bag matches its current schema — and returning here
    // without re-stamping would leave the record on the old version, so the
    // plugin would migrate the same bag again on every single mount.
    if (nextVersion === currentVersion) return { kind: "unchanged" };
    return { kind: "restamp", version: nextVersion };
  }

  // Store what will actually be persisted, not what the caller handed us.
  //
  // Two things fall out of the round trip. The value is *detached*: a caller
  // holding a reference to a patch it submitted — or to the `initialArgs`
  // object it read — can no longer mutate stored state behind the setter's
  // back, skipping validation, the cap and every subscriber. And it is
  // *canonical*: `NaN` and a `Date` become `null` and an ISO string here
  // rather than silently at the next restart, so what the view reads back on
  // remount is what it will read back after a restart.
  return { kind: "replace", state: parseCanonical(serialized), version: nextVersion };
}

/** Why a `persistState` patch was refused. */
export type ExtensionStateRejection = "not-serializable" | "too-large";

export type ExtensionStatePatchResult =
  | { ok: false; reason: "not-serializable" }
  | { ok: false; reason: "too-large"; bytes: number }
  | { ok: true; commit: ExtensionStateCommit };

/**
 * Apply one `persistState` patch to a panel's bag: merge it, refuse a result
 * that cannot round-trip through JSON or that would exceed the cap, and decide
 * what — if anything — the record needs written.
 *
 * `nextVersion` is the version the host stamps on an accepted write; resolving
 * it (the registered kind's declared `stateVersion`) is the caller's job.
 *
 * Throws only when `current` itself is not serializable and the merged bag is
 * over the cap — the app has always let that surface rather than silently
 * measuring an unreadable bag as zero bytes.
 */
export function applyExtensionStatePatch(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
  versions: { current: number | undefined; next: number | undefined }
): ExtensionStatePatchResult {
  const base = current ?? {};
  const serialized = serializeOrUndefined(mergePatch(base, patch));
  if (serialized === undefined) return { ok: false, reason: "not-serializable" };

  // Measured only when the draft is actually over, and deliberately not
  // through `serializeOrUndefined`: see the throw noted above.
  const bytes = byteLength(serialized);
  if (!withinCap(bytes, () => byteLength(JSON.stringify(base) ?? ""))) {
    return { ok: false, reason: "too-large", bytes };
  }

  return {
    ok: true,
    commit: commitExtensionState(
      serializeOrUndefined(base),
      serialized,
      versions.current,
      versions.next
    ),
  };
}
