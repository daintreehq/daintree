import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import type { PanelInstance } from "@shared/types/panel";
import { saveNormalized } from "./persistence";
import { logWarn } from "@/utils/logger";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { isClientMetadataEligible } from "./panelCount";
import {
  MCP_CLIENT_METADATA_KEY,
  MAX_CLIENT_METADATA_BYTES,
  exceedsClientMetadataDepth,
  type ClientMetadataRejection,
} from "@shared/utils/mcpClientMetadata";
import {
  MAX_EXTENSION_STATE_BYTES,
  applyExtensionStatePatch,
  byteLength,
  commitExtensionState,
  mergePatch,
  parseCanonical,
  serializeOrUndefined,
  withinCap,
  type ExtensionStateCommit,
} from "@shared/utils/extensionState";

type Set = PanelRegistryStoreApi["setState"];

interface CommitOutcome {
  /** State to hand back from the zustand updater. */
  next: PanelRegistrySlice | Partial<PanelRegistrySlice>;
  /** False when the store already held the caller's desired bag. */
  changed: boolean;
}

/** Write a commit decided by the shared rules onto the panel record. */
function applyCommit(
  state: PanelRegistrySlice,
  id: string,
  panel: PanelInstance,
  commit: ExtensionStateCommit
): CommitOutcome {
  if (commit.kind === "unchanged") return { next: state, changed: false };
  const updated: PanelInstance =
    commit.kind === "restamp"
      ? { ...panel, extensionStateVersion: commit.version }
      : { ...panel, extensionState: commit.state, extensionStateVersion: commit.version };
  const newById = { ...state.panelsById, [id]: updated };
  saveNormalized(newById, state.panelIds);
  return { next: { panelsById: newById }, changed: commit.kind === "replace" };
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

      const result = applyExtensionStatePatch(panel.extensionState, patch, {
        current: panel.extensionStateVersion,
        next: extensionStateVersion,
      });
      if (!result.ok) {
        if (result.reason === "not-serializable") {
          // A cyclic value, a BigInt, or a throwing `toJSON` would otherwise fail
          // later inside the layout save, where it reads as a persistence bug
          // rather than as a plugin handing us something that cannot round-trip.
          logWarn("Plugin panel state was not serializable; ignoring the update", {
            panelId: id,
            pluginId: panel.pluginId,
          });
        } else {
          logWarn("Plugin panel state exceeds the size limit; ignoring the update", {
            panelId: id,
            pluginId: panel.pluginId,
            bytes: result.bytes,
            limit: MAX_EXTENSION_STATE_BYTES,
          });
        }
        return state;
      }

      // Nothing to write is still a success: the caller's desired state IS what
      // is stored, and reporting failure would make every idempotent re-persist
      // look like a rejection.
      accepted = true;
      return applyCommit(state, id, panel, result.commit).next;
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
      //
      // Depth goes FIRST, before anything recursive touches the value.
      // `JSON.stringify` recurses, so a value nested past the engine's stack
      // throws `RangeError` — caught, and then reported as `invalid-json`,
      // which is the one explanation that does not tell the caller what to do.
      // The walk below is iterative, so it answers on any input.
      let canonical: Record<string, unknown> | null = null;
      if (value !== null) {
        if (exceedsClientMetadataDepth(value)) {
          outcome = { ok: false, reason: "too-deep" };
          return state;
        }
        const sliceSerialized = serializeOrUndefined(value);
        if (sliceSerialized === undefined) {
          outcome = { ok: false, reason: "invalid-json" };
          return state;
        }
        // Measured and stored as ONE representation. `toJSON` is handed the key
        // it is serializing under, so a value that answers differently for ""
        // and for "mcp" would otherwise be measured as one record and stored as
        // another — passing a 2KB check and persisting something larger.
        // Canonicalizing here means the bytes checked are the bytes kept.
        canonical = parseCanonical(sliceSerialized);
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
        [MCP_CLIENT_METADATA_KEY]: canonical ?? undefined,
      });

      const serialized = serializeOrUndefined(draft);
      if (serialized === undefined) {
        // Reachable even with a valid slice: the rest of the bag is not this
        // caller's to keep serializable.
        outcome = { ok: false, reason: "invalid-json" };
        return state;
      }
      if (!withinCap(byteLength(serialized), () => byteLength(currentSerialized ?? ""))) {
        outcome = { ok: false, reason: "state-too-large" };
        return state;
      }

      // The version stamp stays exactly where it was, which is the one place
      // this parts company with the plugin policy. `terminal` IS a registered
      // kind and declares no `stateVersion`, so reusing that branch would stamp
      // `undefined` and erase a version a restore had carried forward — on
      // behalf of a caller that wrote nothing the panel's own schema describes.
      const committed = applyCommit(
        state,
        id,
        panel,
        commitExtensionState(
          currentSerialized,
          serialized,
          panel.extensionStateVersion,
          panel.extensionStateVersion
        )
      );
      outcome = { ok: true, changed: committed.changed };
      return committed.next;
    });
    return outcome;
  },
});

export { MAX_EXTENSION_STATE_BYTES };
