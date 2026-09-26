import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

/**
 * Which forge credentials the user has already been told about. Keyed by
 * canonical provider id; the value is the fingerprint of the credential that
 * was failing when the token callout was dismissed. A replaced credential has
 * a different fingerprint, so its first failure re-arms the callout — nothing
 * else does: not a project switch, a fresh view, a restart, or a health probe
 * flapping under the same token (#12831).
 */
export const FORGE_TOKEN_CALLOUT_STORAGE_KEY = "daintree-forge-token-callout";

interface ForgeTokenCalloutPersistedState {
  dismissed: Record<string, string>;
}

interface ForgeTokenCalloutState extends ForgeTokenCalloutPersistedState {
  dismiss: (providerId: string, fingerprint: string) => void;
}

// Every project view writes this key from its own V8 context; merge by the
// writer's delta so a stale view can't drop a dismissal a sibling just made.
function mergeDismissals({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<ForgeTokenCalloutPersistedState>) {
  return {
    ...incoming,
    state: {
      dismissed: mergeRecordByWriterDelta(
        baseline?.state.dismissed ?? {},
        incoming.state.dismissed,
        onDisk?.state.dismissed ?? {}
      ),
    },
  };
}

function readDismissed(persisted: unknown): Record<string, string> | null {
  if (!persisted || typeof persisted !== "object" || !("dismissed" in persisted)) return null;
  const { dismissed } = persisted;
  if (!dismissed || typeof dismissed !== "object") return null;
  const clean: Record<string, string> = {};
  for (const [id, fp] of Object.entries(dismissed)) {
    if (typeof fp === "string") clean[id] = fp;
  }
  return clean;
}

export const useForgeTokenCalloutStore = create<ForgeTokenCalloutState>()(
  persist(
    (set) => ({
      dismissed: {},
      dismiss: (providerId, fingerprint) =>
        set((s) =>
          s.dismissed[providerId] === fingerprint
            ? s
            : { dismissed: { ...s.dismissed, [providerId]: fingerprint } }
        ),
    }),
    {
      name: FORGE_TOKEN_CALLOUT_STORAGE_KEY,
      version: 0,
      storage: createSafeJSONStorage<ForgeTokenCalloutPersistedState>({
        mergeOnWrite: mergeDismissals,
      }),
      partialize: (s) => ({ dismissed: s.dismissed }),
      merge: (persisted, current) => {
        const dismissed = readDismissed(persisted);
        return dismissed ? { ...current, dismissed } : current;
      },
    }
  )
);

// A persist store hydrates once per view, so a cached view would keep showing
// a callout another view already dismissed. Views share the storage partition,
// so the sibling's write arrives here as a `storage` event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== FORGE_TOKEN_CALLOUT_STORAGE_KEY) return;
    void useForgeTokenCalloutStore.persist.rehydrate();
  });
}

registerPersistedStore({
  storeId: "forgeTokenCalloutStore",
  store: useForgeTokenCalloutStore,
  persistedStateType: "{ dismissed: Record<string, string> }",
});
