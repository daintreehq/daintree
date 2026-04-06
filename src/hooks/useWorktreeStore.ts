import { use } from "react";
import { useStore } from "zustand";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";

export function useWorktreeStore<T>(
  selector: (state: WorktreeViewState & WorktreeViewActions) => T
): T {
  const store = use(WorktreeStoreContext);
  if (!store) {
    throw new Error("useWorktreeStore must be used within WorktreeStoreProvider");
  }
  return useStore(store, selector);
}
