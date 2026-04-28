import { create } from "zustand";
import type { CloudSyncService } from "@/utils/cloudSyncDetection";

interface CloudSyncBannerState {
  service: CloudSyncService | null;
  setService: (service: CloudSyncService | null) => void;
}

export const useCloudSyncBannerStore = create<CloudSyncBannerState>((set) => ({
  service: null,
  setService: (service) => set({ service }),
}));
