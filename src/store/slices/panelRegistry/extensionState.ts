import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import type { PanelInstance } from "@shared/types/panel";
import { saveNormalized } from "./persistence";
import { logWarn } from "@/utils/logger";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { isEphemeralPanel } from "./panelCount";
import {
  MCP_CLIENT_METADATA_KEY,
  MAX_CLIENT_METADATA_BYTES,
  exceedsClientMetadataDepth,
  type ClientMetadataRejection,
} from "@shared/utils/mcpClientMetadata";

type Set = PanelRegistryStoreApi["setState"];

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
const MAX_EXTENSION_STATE_BYTES = 64 * 1024;

/**
 * Re-read a bag from its own serialization.
 *
 * The input is always `JSON.stringify` of an object this module built, so the
 * result is an object — narrowed by check rather than asserted, because the
 * whole point of the round trip is that nothing here trusts its input.
 */
function parseCanonical(serialized: string): Record<string, unknown> {
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
function serializeOrUndefined(value: unknown): string | undefined {
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
function byteLength(serialized: string): number {
  return new TextEncoder().encode(serialized).length;
}

/** Merge a patch into a bag, with `undefined` removing the key. */
function mergePatch(
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
function withinCap(bytes: number, currentBytes: number): boolean {
  if (bytes <= MAX_EXTENSION_STATE_BYTES) return true;
  return currentBytes > MAX_EXTENSION_STATE_BYTES && bytes < currentBytes;
}

interface CommitOutcome {
  /** State to hand back from the zustand updater. */
  next: PanelRegistrySlice | Partial<PanelRegistrySlice>;
  /** False when the store already held the caller's desired bag. */
  changed: boolean;
}

/**
 * Canonicalize a merged bag, compare it against what is stored, and commit.
 *
 * The shared half of both write policies: what differs between them is who may
 * write, what they may write, and whether the version moves — not how the
 * result is stored.
 */
function commitMergedState(
  state: PanelRegistrySlice,
  id: string,
  panel: PanelInstance,
  currentSerialized: string | undefined,
  serialized: string,
  extensionStateVersion: number | undefined
): CommitOutcome {
  // Store what will actually be persisted, not what the caller handed us.
  //
  // Two things fall out of the round trip. The value is *detached*: a caller
  // holding a reference to a patch it submitted — or to the `initialArgs`
  // object it read — can no longer mutate store state behind the setter's
  // back, skipping validation, the cap and every subscriber. And it is
  // *canonical*: `NaN` and a `Date` become `null` and an ISO string here
  // rather than silently at the next restart, so what the view reads back on
  // remount is what it will read back after a restart.
  const merged = parseCanonical(serialized);

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
    if (extensionStateVersion === panel.extensionStateVersion) {
      return { next: state, changed: false };
    }
    const restamped = {
      ...state.panelsById,
      [id]: { ...panel, extensionStateVersion },
    };
    saveNormalized(restamped, state.panelIds);
    return { next: { panelsById: restamped }, changed: false };
  }

  const newById = {
    ...state.panelsById,
    [id]: { ...panel, extensionState: merged, extensionStateVersion },
  };
  saveNormalized(newById, state.panelIds);
  return { next: { panelsById: newById }, changed: true };
}

/**
 * Panels an external MCP client may attach its own correlation metadata to
 * (#12340).
 *
 * Exactly the inverse of the plugin gate, so the two write policies are
 * disjoint by construction and the reserved key can never collide with a bag a
 * plugin owns. Ephemeral panels are excluded for the reason `terminal.list`
 * already excludes them: they are tooling-internal, and a surface that cannot
 * enumerate them must not be able to write to them either.
 */
function isClientMetadataEligible(panel: PanelInstance): boolean {
  return panel.kind === "terminal" && panel.pluginId === undefined && !isEphemeralPanel(panel);
}

/**
 * Merge a patch into a plugin panel's `extensionState`.
 *
 * This is the write half of the bag a view reads as `PanelViewProps.initialArgs`
 * — one bag, seeded at spawn and updated here, so a remounted or restored panel
 * comes back the way the user left it. Without it a plugin panel could only ever
 * see its spawn arguments, and a plugin-authored file browser would forget its
 * expansion, selection and root every time the user maximized a sibling pane.
 *
 * Merged rather than replaced so two independent parts of a view can each
 * persist their own key without reading and rewriting the whole bag. A key set
 * to `undefined` is removed, which is the only way to shrink the bag.
 */
export const createExtensionStateActions = (
  set: Set
): Pick<PanelRegistrySlice, "setPanelExtensionState" | "setPanelClientMetadata"> => ({
  setPanelExtensionState: (id, patch) => {
    // Reported back to the caller so a view is not told it persisted when the
    // host rejected the write. Set inside the updater, which zustand runs
    // synchronously, so it is settled by the time this returns.
    let accepted = false;
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) return state;
      // Built-in kinds carry no plugin view and reach their state through their
      // own typed setters; letting this write to one would put unvalidated
      // content on a record whose serializer does not expect it. The one thing
      // an external caller may write to a built-in terminal goes through
      // `setPanelClientMetadata`, which owns a single reserved key.
      if (panel.pluginId === undefined) return state;

      const current = panel.extensionState ?? {};
      const currentSerialized = serializeOrUndefined(current);
      const draft = mergePatch(current, patch);

      const serialized = serializeOrUndefined(draft);
      if (serialized === undefined) {
        // A cyclic value, a BigInt, or a throwing `toJSON` would otherwise fail
        // later inside the layout save, where it reads as a persistence bug
        // rather than as a plugin handing us something that cannot round-trip.
        logWarn("Plugin panel state was not serializable; ignoring the update", {
          panelId: id,
          pluginId: panel.pluginId,
        });
        return state;
      }

      const bytes = byteLength(serialized);
      if (!withinCap(bytes, byteLength(currentSerialized ?? ""))) {
        logWarn("Plugin panel state exceeds the size limit; ignoring the update", {
          panelId: id,
          pluginId: panel.pluginId,
          bytes,
          limit: MAX_EXTENSION_STATE_BYTES,
        });
        return state;
      }

      // The write gate is the only place the state version moves (#12280). A
      // plugin that writes has, by doing so, produced a bag at the version it
      // currently declares — and it can only reach inside `extensionState`, so
      // the number is the host's to stamp and not the plugin's to claim.
      //
      // A REGISTERED kind's declared version wins outright, absence included: a
      // build that declares none has just written a bag of unknown shape, and
      // keeping the number the previous build stamped would present that
      // rewrite as state the older schema never produced. Only an unregistered
      // kind carries its stamp forward, having written nothing to invalidate it.
      const kindConfig = getPanelKindConfig(panel.kind ?? "");
      const extensionStateVersion =
        kindConfig !== undefined ? kindConfig.stateVersion : panel.extensionStateVersion;

      // Nothing to write is still a success: the caller's desired state IS what
      // is stored, and reporting failure would make every idempotent re-persist
      // look like a rejection.
      accepted = true;
      return commitMergedState(
        state,
        id,
        panel,
        currentSerialized,
        serialized,
        extensionStateVersion
      ).next;
    });
    return accepted;
  },

  setPanelClientMetadata: (id, value) => {
    let outcome: { ok: true; changed: boolean } | { ok: false; reason: ClientMetadataRejection } = {
      ok: false,
      reason: "not-found",
    };
    set((state) => {
      const panel = state.panelsById[id];
      if (!panel) {
        outcome = { ok: false, reason: "not-found" };
        return state;
      }
      if (!isClientMetadataEligible(panel)) {
        outcome = { ok: false, reason: "not-eligible" };
        return state;
      }

      // The slice is validated on its own before it reaches the bag, so a
      // rejection names what the caller actually got wrong rather than
      // reporting the whole panel's state as oversized.
      if (value !== null) {
        const sliceSerialized = serializeOrUndefined(value);
        if (sliceSerialized === undefined) {
          outcome = { ok: false, reason: "invalid-json" };
          return state;
        }
        if (exceedsClientMetadataDepth(value)) {
          outcome = { ok: false, reason: "too-deep" };
          return state;
        }
        if (byteLength(sliceSerialized) > MAX_CLIENT_METADATA_BYTES) {
          outcome = { ok: false, reason: "metadata-too-large" };
          return state;
        }
      }

      const current = panel.extensionState ?? {};
      const currentSerialized = serializeOrUndefined(current);
      // Merged into the bag, never replacing it. A built-in terminal's bag
      // already carries `presetEnv` on the missing-CLI path, and replacing the
      // whole thing would drop the environment a "Run anyway" relaunch rebuilds
      // itself from.
      const draft = mergePatch(current, {
        [MCP_CLIENT_METADATA_KEY]: value === null ? undefined : value,
      });

      const serialized = serializeOrUndefined(draft);
      if (serialized === undefined) {
        // Reachable even with a valid slice: the rest of the bag is not this
        // caller's to keep serializable.
        outcome = { ok: false, reason: "invalid-json" };
        return state;
      }
      if (!withinCap(byteLength(serialized), byteLength(currentSerialized ?? ""))) {
        outcome = { ok: false, reason: "state-too-large" };
        return state;
      }

      // The version stamp stays exactly where it was, which is the one place
      // this parts company with the plugin policy. `terminal` IS a registered
      // kind and declares no `stateVersion`, so reusing that branch would stamp
      // `undefined` and erase a version a restore had carried forward — on
      // behalf of a caller that wrote nothing the panel's own schema describes.
      const committed = commitMergedState(
        state,
        id,
        panel,
        currentSerialized,
        serialized,
        panel.extensionStateVersion
      );
      outcome = { ok: true, changed: committed.changed };
      return committed.next;
    });
    return outcome;
  },
});

export { MAX_EXTENSION_STATE_BYTES };
