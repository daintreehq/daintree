import { create } from "zustand";

interface NotificationSettingsState {
  enabled: boolean;
  hydrated: boolean;
  hydrate(): Promise<void>;
  setEnabled(value: boolean): void;
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  enabled: true,
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    try {
      const settings = await window.electron?.notification?.getSettings();
      if (settings) {
        set({ enabled: settings.enabled !== false, hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },

  setEnabled(value: boolean) {
    const prev = get().enabled;
    set({ enabled: value });
    window.electron?.notification?.setSettings({ enabled: value }).catch(() => {
      set({ enabled: prev });
    });
  },
}));
