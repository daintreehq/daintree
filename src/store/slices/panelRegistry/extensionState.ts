import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { saveNormalized } from "./persistence";
import { logWarn } from "@/utils/logger";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";

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
): Pick<PanelRegistrySlice, "setPanelExtensionState"> => ({
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
      // content on a record whose serializer does not expect it.
      if (panel.pluginId === undefined) return state;

      const current = panel.extensionState ?? {};
      const draft: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete draft[key];
        else draft[key] = value;
      }

      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(draft);
      } catch {
        // A cyclic value, a BigInt, or a throwing `toJSON` would otherwise fail
        // later inside the layout save, where it reads as a persistence bug
        // rather than as a plugin handing us something that cannot round-trip.
        serialized = undefined;
      }
      // `JSON.stringify` also returns `undefined` outright — for a value whose
      // `toJSON` returns `undefined`, say — which is not an exception and would
      // crash the next line rather than being rejected.
      if (typeof serialized !== "string") {
        logWarn("Plugin panel state was not serializable; ignoring the update", {
          panelId: id,
          pluginId: panel.pluginId,
        });
        return state;
      }

      // Byte length, not `String.length`: the latter counts UTF-16 code units,
      // so ~30k CJK characters would measure as well under a 64KB cap while
      // occupying ~90KB once encoded.
      const bytes = new TextEncoder().encode(serialized).length;
      if (bytes > MAX_EXTENSION_STATE_BYTES) {
        const currentBytes = new TextEncoder().encode(JSON.stringify(current) ?? "").length;
        // A bag that is somehow already over the cap — legacy state, or spawn
        // arguments that never passed through here — must still be shrinkable,
        // or the plugin is locked out of the only action that could fix it.
        if (currentBytes <= MAX_EXTENSION_STATE_BYTES || bytes >= currentBytes) {
          logWarn("Plugin panel state exceeds the size limit; ignoring the update", {
            panelId: id,
            pluginId: panel.pluginId,
            bytes,
            limit: MAX_EXTENSION_STATE_BYTES,
          });
          return state;
        }
      }

      // Store what will actually be persisted, not what the plugin handed us.
      //
      // Two things fall out of the round trip. The value is *detached*: a plugin
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
      let currentSerialized: string | undefined;
      try {
        currentSerialized = JSON.stringify(current);
      } catch {
        currentSerialized = undefined;
      }
      if (currentSerialized === serialized) {
        // Nothing to write, but the caller's desired state IS what is stored —
        // reporting failure here would make every idempotent re-persist look
        // like a rejection.
        accepted = true;
        return state;
      }

      // The write gate is the only place the state version moves (#12280). A
      // plugin that writes has, by doing so, produced a bag at the version it
      // currently declares — and it can only reach inside `extensionState`, so
      // the number is the host's to stamp and not the plugin's to claim. A kind
      // the registry no longer answers for keeps whatever version the record
      // already carries rather than being re-stamped as versionless.
      const declaredStateVersion = getPanelKindConfig(panel.kind ?? "")?.stateVersion;
      const extensionStateVersion = declaredStateVersion ?? panel.extensionStateVersion;

      const newById = {
        ...state.panelsById,
        [id]: {
          ...panel,
          extensionState: merged,
          ...(extensionStateVersion !== undefined && { extensionStateVersion }),
        },
      };
      saveNormalized(newById, state.panelIds);
      accepted = true;
      return { panelsById: newById };
    });
    return accepted;
  },
});

export { MAX_EXTENSION_STATE_BYTES };
