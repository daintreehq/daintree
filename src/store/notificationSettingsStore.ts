import { create } from "zustand";

interface NotificationSettingsState {
  enabled: boolean;
  hydrated: boolean;
  quietHoursEnabled: boolean;
  quietHoursStartMin: number;
  quietHoursEndMin: number;
  quietHoursWeekdays: number[];
  hydrate(): Promise<void>;
  setEnabled(value: boolean): void;
  setQuietHoursEnabled(value: boolean): void;
  setQuietHoursStartMin(value: number): void;
  setQuietHoursEndMin(value: number): void;
  setQuietHoursWeekdays(value: number[]): void;
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  enabled: true,
  hydrated: false,
  quietHoursEnabled: false,
  quietHoursStartMin: 22 * 60,
  quietHoursEndMin: 8 * 60,
  quietHoursWeekdays: [],

  async hydrate() {
    if (get().hydrated) return;
    try {
      const settings = await window.electron?.notification?.getSettings();
      if (settings) {
        set({
          enabled: settings.enabled !== false,
          quietHoursEnabled: settings.quietHoursEnabled === true,
          quietHoursStartMin:
            typeof settings.quietHoursStartMin === "number" ? settings.quietHoursStartMin : 22 * 60,
          quietHoursEndMin:
            typeof settings.quietHoursEndMin === "number" ? settings.quietHoursEndMin : 8 * 60,
          quietHoursWeekdays: Array.isArray(settings.quietHoursWeekdays)
            ? settings.quietHoursWeekdays
            : [],
        });
      }
    } catch {
      // fall through — always mark hydrated below so retries don't thrash IPC
    } finally {
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

  setQuietHoursEnabled(value: boolean) {
    const prev = get().quietHoursEnabled;
    set({ quietHoursEnabled: value });
    window.electron?.notification?.setSettings({ quietHoursEnabled: value }).catch(() => {
      set({ quietHoursEnabled: prev });
    });
  },

  setQuietHoursStartMin(value: number) {
    const prev = get().quietHoursStartMin;
    const clamped = Math.max(0, Math.min(1439, Math.floor(value)));
    set({ quietHoursStartMin: clamped });
    window.electron?.notification?.setSettings({ quietHoursStartMin: clamped }).catch(() => {
      set({ quietHoursStartMin: prev });
    });
  },

  setQuietHoursEndMin(value: number) {
    const prev = get().quietHoursEndMin;
    const clamped = Math.max(0, Math.min(1439, Math.floor(value)));
    set({ quietHoursEndMin: clamped });
    window.electron?.notification?.setSettings({ quietHoursEndMin: clamped }).catch(() => {
      set({ quietHoursEndMin: prev });
    });
  },

  setQuietHoursWeekdays(value: number[]) {
    const prev = get().quietHoursWeekdays;
    const cleaned = Array.from(
      new Set(value.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    ).sort((a, b) => a - b);
    set({ quietHoursWeekdays: cleaned });
    window.electron?.notification?.setSettings({ quietHoursWeekdays: cleaned }).catch(() => {
      set({ quietHoursWeekdays: prev });
    });
  },
}));
