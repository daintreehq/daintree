import { create } from "zustand";
import type { CloudSyncService } from "@/utils/cloudSyncDetection";

interface CloudSyncBannerState {
  service: CloudSyncService | null;
  /** Project the detected service belongs to. Used by the banner to guard
   *  against dismissing the wrong project after a quick switch. */
  projectId: string | null;
  setBanner: (state: { service: CloudSyncService | null; projectId: string | null }) => void;
}

export const useCloudSyncBannerStore = create<CloudSyncBannerState>((set) => ({
  service: null,
  projectId: null,
  setBanner: ({ service, projectId }) => set({ service, projectId }),
}));
