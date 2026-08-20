import { create } from "zustand";

interface NotificationSettingsState {
  enabled: boolean;
  hydrated: boolean;
  // Per-kind toggles, mirrored from IPC settings so the notification center can
  // compute a "what will fire right now" summary without a per-open IPC round
  // trip. These gate the main-process completion/waiting notifications and the
  // working-pulse / UI-feedback sounds — they are display-only here.
  completedEnabled: boolean;
  waitingEnabled: boolean;
  workingPulseEnabled: boolean;
  uiFeedbackSoundEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStartMin: number;
  quietHoursEndMin: number;
  quietHoursWeekdays: number[];
  groupByContext: boolean;
  // Reactive mirror of session-mute timestamp (epoch ms). Drives toolbar
  // DND indicator. In-memory only — meaningless across restarts.
  quietUntil: number;
  // OS-level Do-Not-Disturb / Focus state mirrored from the main-process
  // OsDndService. `undefined` = unknown (unsupported platform / detection
  // failed); consumers must treat it as "do not gate". Display-only here —
  // never a toast-suppression gate (the OS already silences native banners).
  osDndActive: boolean | undefined;
  hydrate(): Promise<void>;
  /**
   * Re-read settings from the main process, ignoring the hydrated guard.
   * `hydrate()` early-returns once hydrated, so anything that changes settings
   * behind this store's back — importing a configuration bundle (#11889) — has
   * no way to refresh the mirror without it.
   */
  rehydrate(): Promise<void>;
  setEnabled(value: boolean): void;
  setQuietHoursEnabled(value: boolean): void;
  setQuietHoursStartMin(value: number): void;
  setQuietHoursEndMin(value: number): void;
  setQuietHoursWeekdays(value: number[]): void;
  setGroupByContext(value: boolean): void;
  setQuietUntil(ts: number): void;
  setOsDndActive(value: boolean | undefined): void;
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  enabled: true,
  hydrated: false,
  // Pre-hydration defaults mirror the main-process persisted defaults
  // (electron/store.ts) so the summary doesn't flash a wrong state before
  // hydrate() settles.
  completedEnabled: false,
  waitingEnabled: true,
  workingPulseEnabled: false,
  uiFeedbackSoundEnabled: false,
  quietHoursEnabled: false,
  quietHoursStartMin: 22 * 60,
  quietHoursEndMin: 8 * 60,
  quietHoursWeekdays: [],
  groupByContext: false,
  quietUntil: 0,
  osDndActive: undefined,

  async rehydrate() {
    set({ hydrated: false });
    await get().hydrate();
  },

  async hydrate() {
    if (get().hydrated) return;
    try {
      const settings = await window.electron?.notification?.getSettings();
      if (settings) {
        set({
          enabled: settings.enabled !== false,
          completedEnabled: settings.completedEnabled === true,
          waitingEnabled: settings.waitingEnabled !== false,
          workingPulseEnabled: settings.workingPulseEnabled === true,
          uiFeedbackSoundEnabled: settings.uiFeedbackSoundEnabled === true,
          quietHoursEnabled: settings.quietHoursEnabled === true,
          quietHoursStartMin:
            typeof settings.quietHoursStartMin === "number" ? settings.quietHoursStartMin : 22 * 60,
          quietHoursEndMin:
            typeof settings.quietHoursEndMin === "number" ? settings.quietHoursEndMin : 8 * 60,
          quietHoursWeekdays: Array.isArray(settings.quietHoursWeekdays)
            ? settings.quietHoursWeekdays
            : [],
          groupByContext: settings.groupByContext === true,
        });
      }
      // Hydrate the OS DND signal alongside notification settings. A push
      // event may have already arrived (subscription is set up earlier in
      // App startup); only adopt the IPC snapshot when the live store value
      // is still its `undefined` default so we don't clobber a fresher push.
      try {
        const initialOsDnd = await window.electron?.osDnd?.getState();
        if (get().osDndActive === undefined) {
          set({ osDndActive: initialOsDnd });
        }
      } catch {
        // Leave osDndActive at its current value on IPC failure.
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

  setGroupByContext(value: boolean) {
    const prev = get().groupByContext;
    set({ groupByContext: value });
    window.electron?.notification?.setSettings({ groupByContext: value }).catch(() => {
      set({ groupByContext: prev });
    });
  },

  setQuietUntil(ts: number) {
    set({ quietUntil: Number.isFinite(ts) ? ts : 0 });
  },

  setOsDndActive(value: boolean | undefined) {
    set({ osDndActive: value });
  },
}));
