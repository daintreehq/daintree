import { create } from "zustand";

export type UpdateStatus = "idle" | "available" | "downloading" | "downloaded" | "error";

interface UpdateStore {
  status: UpdateStatus;
  version: string | null;
  progress: number;
  error: string | null;
  dismissed: boolean;
  setAvailable: (version: string) => void;
  setDownloading: (percent: number) => void;
  setDownloaded: (version: string) => void;
  setError: (message: string) => void;
  dismiss: () => void;
  reset: () => void;
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  status: "idle",
  version: null,
  progress: 0,
  error: null,
  dismissed: false,
  setAvailable: (version) => set({ status: "available", version, progress: 0, error: null, dismissed: false }),
  setDownloading: (percent) => set({ status: "downloading", progress: Math.min(Math.max(percent, 0), 100) }),
  setDownloaded: (version) =>
    set({ status: "downloaded", version, progress: 100, error: null, dismissed: false }),
  setError: (message) => set({ status: "error", error: message, progress: 0 }),
  dismiss: () => set({ dismissed: true }),
  reset: () => set({ status: "idle", version: null, progress: 0, error: null, dismissed: false }),
}));
