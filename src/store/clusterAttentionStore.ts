import { create } from "zustand";

/**
 * Session-local dismissal state for cluster-attention pills.
 *
 * Signatures encode cluster type + sorted member IDs + latest state-change
 * timestamp. A signature therefore changes whenever the cluster's membership
 * or its most recent member transition changes, so a prior dismissal naturally
 * expires when a cluster dissolves and reforms. No persistence — state resets
 * on app reload.
 */
interface ClusterAttentionState {
  dismissedSignatures: Set<string>;
  dismiss: (signature: string) => void;
  reset: () => void;
}

export const useClusterAttentionStore = create<ClusterAttentionState>()((set) => ({
  dismissedSignatures: new Set<string>(),
  dismiss: (signature) =>
    set((s) => {
      if (s.dismissedSignatures.has(signature)) return {};
      const next = new Set(s.dismissedSignatures);
      next.add(signature);
      return { dismissedSignatures: next };
    }),
  reset: () => set({ dismissedSignatures: new Set<string>() }),
}));
