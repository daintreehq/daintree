import { create } from "zustand";

interface RosettaBannerState {
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

export const useRosettaBannerStore = create<RosettaBannerState>((set) => ({
  visible: false,
  setVisible: (visible) => set({ visible }),
}));
