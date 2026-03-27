import { create } from "zustand";

export type UpdateStatus = "idle" | "available" | "downloading" | "downloaded";

interface UpdateStore {
  status: UpdateStatus;
  version: string | null;
  progress: number;
  dismissed: boolean;
  setAvailable: (version: string) => void;
  setDownloading: (percent: number) => void;
  setDownloaded: (version: string) => void;
  dismiss: () => void;
  reset: () => void;
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: "idle",
  version: null,
  progress: 0,
  dismissed: false,
  setAvailable: (version) => set({ status: "available", version, progress: 0, dismissed: false }),
  setDownloading: (percent) =>
    set({ status: "downloading", progress: Math.min(Math.max(percent, 0), 100) }),
  setDownloaded: (version) =>
    set({ status: "downloaded", version, progress: 100, dismissed: false }),
  dismiss: () => set({ dismissed: true }),
  reset: () => set({ status: "idle", version: null, progress: 0, dismissed: false }),
}));
