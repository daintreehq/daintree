import { create } from "zustand";
import { RESOURCE_PROFILE_CONFIGS, type ResourceProfile } from "@shared/types/resourceProfile";

interface ResourceProfileStoreState {
  fetchIntervalActiveMs: number;
  fetchIntervalBackgroundMs: number;
  profile: ResourceProfile;
  setProfile: (profile: ResourceProfile) => void;
}

export const useResourceProfileStore = create<ResourceProfileStoreState>((set) => ({
  fetchIntervalActiveMs: RESOURCE_PROFILE_CONFIGS.balanced.fetchIntervalActiveMs,
  fetchIntervalBackgroundMs: RESOURCE_PROFILE_CONFIGS.balanced.fetchIntervalBackgroundMs,
  profile: "balanced" as ResourceProfile,
  setProfile: (profile) => {
    const config = RESOURCE_PROFILE_CONFIGS[profile];
    set({
      profile,
      fetchIntervalActiveMs: config.fetchIntervalActiveMs,
      fetchIntervalBackgroundMs: config.fetchIntervalBackgroundMs,
    });
  },
}));
