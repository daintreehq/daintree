import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

const getSettings = vi.fn();

beforeEach(() => {
  getSettings.mockReset();
  useNotificationSettingsStore.setState({
    enabled: true,
    hydrated: false,
    completedEnabled: true,
    waitingEnabled: true,
    workingPulseEnabled: false,
    uiFeedbackSoundEnabled: false,
  });
  (globalThis as { window?: unknown }).window = {
    electron: { notification: { getSettings } },
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("notificationSettingsStore hydrate — per-kind toggles", () => {
  it("mirrors the per-kind toggles from IPC settings", async () => {
    getSettings.mockResolvedValue({
      enabled: true,
      completedEnabled: false,
      waitingEnabled: true,
      workingPulseEnabled: true,
      uiFeedbackSoundEnabled: true,
    });

    await useNotificationSettingsStore.getState().hydrate();

    const s = useNotificationSettingsStore.getState();
    expect(s.completedEnabled).toBe(false);
    expect(s.waitingEnabled).toBe(true);
    expect(s.workingPulseEnabled).toBe(true);
    expect(s.uiFeedbackSoundEnabled).toBe(true);
    expect(s.hydrated).toBe(true);
  });

  it("applies defensive defaults when IPC omits the per-kind fields", async () => {
    // completed/waiting default on (=== false guard), sound kinds default off (=== true guard).
    getSettings.mockResolvedValue({ enabled: true });

    await useNotificationSettingsStore.getState().hydrate();

    const s = useNotificationSettingsStore.getState();
    expect(s.completedEnabled).toBe(true);
    expect(s.waitingEnabled).toBe(true);
    expect(s.workingPulseEnabled).toBe(false);
    expect(s.uiFeedbackSoundEnabled).toBe(false);
  });

  it("is idempotent — a second hydrate is a no-op", async () => {
    getSettings.mockResolvedValue({ enabled: true, completedEnabled: false });

    await useNotificationSettingsStore.getState().hydrate();
    expect(useNotificationSettingsStore.getState().completedEnabled).toBe(false);

    // Settings change behind our back; hydrate must not re-read.
    getSettings.mockResolvedValue({ enabled: true, completedEnabled: true });
    await useNotificationSettingsStore.getState().hydrate();

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(useNotificationSettingsStore.getState().completedEnabled).toBe(false);
  });
});
