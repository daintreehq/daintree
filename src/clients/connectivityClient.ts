import type { ServiceConnectivityPayload, ServiceConnectivitySnapshot } from "@shared/types";

export const connectivityClient = {
  getState: (): Promise<ServiceConnectivitySnapshot> => {
    return window.electron.connectivity.getState();
  },

  onServiceChanged: (callback: (payload: ServiceConnectivityPayload) => void): (() => void) => {
    return window.electron.connectivity.onServiceChanged(callback);
  },
};
