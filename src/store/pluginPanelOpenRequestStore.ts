import { create } from "zustand";
import type { PanelViewProps } from "@shared/types/plugin";
import {
  MAX_EXTENSION_STATE_BYTES,
  byteLength,
  parseCanonical,
  serializeOrUndefined,
} from "@shared/utils/extensionState";

export type PluginPanelOpenRequest = NonNullable<PanelViewProps["openRequest"]>;

interface PanelOpenRequestEntry {
  request: PluginPanelOpenRequest;
  /** The newest `seq` a committed view has rendered; 0 when none has. */
  deliveredSeq: number;
}

interface PluginPanelOpenRequestState {
  entriesByPanelId: Record<string, PanelOpenRequestEntry>;
  /**
   * Replace the panel's waiting request with `args`. Returns false, leaving
   * the slot as it was, when `args` can't round-trip through JSON or exceeds
   * the extension-state cap.
   */
  publish: (panelId: string, args: Record<string, unknown>) => boolean;
  /** A committed view rendered `seq`. Ignored unless `seq` is still the latest. */
  markDelivered: (panelId: string, seq: number) => void;
  /** The panel closed. */
  clearPanel: (panelId: string) => void;
}

// Module-scoped rather than per panel, so a slot cleared and re-published
// under the same id can never hand out a `seq` an old view already acked.
let nextSeq = 1;

/**
 * Arguments from `panel.openPluginPanel` calls that reused an open panel
 * (#13779), one latest request per panel. Keyed by panel rather than held by
 * the view, so a request made while the view is unmounted is still there for
 * the next mount; `deliveredSeq` is what stops that next mount replaying a
 * request an earlier view already committed with. Not persisted: an open request is
 * an intent, not state, and replaying one after a restart would undo whatever
 * the user did since. The renderer store orchestrator prunes a closed panel.
 */
export const usePluginPanelOpenRequestStore = create<PluginPanelOpenRequestState>((set) => ({
  entriesByPanelId: {},
  publish: (panelId, args) => {
    // The same canonical form `persistState` stores, so a request reads the
    // way the bag would after a restart and is detached from the caller's
    // object.
    const serialized = serializeOrUndefined(args);
    if (serialized === undefined || byteLength(serialized) > MAX_EXTENSION_STATE_BYTES) {
      return false;
    }
    const request: PluginPanelOpenRequest = { seq: nextSeq++, args: parseCanonical(serialized) };
    set((current) => ({
      entriesByPanelId: {
        ...current.entriesByPanelId,
        [panelId]: {
          request,
          deliveredSeq: current.entriesByPanelId[panelId]?.deliveredSeq ?? 0,
        },
      },
    }));
    return true;
  },
  markDelivered: (panelId, seq) =>
    set((current) => {
      const entry = current.entriesByPanelId[panelId];
      if (!entry || entry.request.seq !== seq || entry.deliveredSeq === seq) return current;
      return {
        entriesByPanelId: {
          ...current.entriesByPanelId,
          [panelId]: { ...entry, deliveredSeq: seq },
        },
      };
    }),
  clearPanel: (panelId) =>
    set((current) => {
      if (!(panelId in current.entriesByPanelId)) return current;
      const { [panelId]: _removed, ...entriesByPanelId } = current.entriesByPanelId;
      return { entriesByPanelId };
    }),
}));

/** The newest request a view has rendered for the panel, as a baseline for the next attempt. */
export function readDeliveredOpenRequestSeq(panelId: string): number {
  return usePluginPanelOpenRequestStore.getState().entriesByPanelId[panelId]?.deliveredSeq ?? 0;
}

/** The panel's latest request; the reference holds while it is unchanged. */
export function usePanelOpenRequest(panelId: string): PluginPanelOpenRequest | undefined {
  return usePluginPanelOpenRequestStore((s) => s.entriesByPanelId[panelId]?.request);
}
