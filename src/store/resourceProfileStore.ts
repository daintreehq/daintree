import { create } from "zustand";
import type { ResourceProfile } from "@shared/types/resourceProfile";

interface ResourceProfileStoreState {
  profile: ResourceProfile;
  setProfile: (profile: ResourceProfile) => void;
}

export const useResourceProfileStore = create<ResourceProfileStoreState>((set) => ({
  profile: "balanced" as ResourceProfile,
  setProfile: (profile) => set({ profile }),
}));
