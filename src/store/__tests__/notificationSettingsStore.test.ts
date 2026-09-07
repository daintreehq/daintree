import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

const getSettings = vi.fn();
const getOsDndState = vi.fn();

beforeEach(() => {
  getSettings.mockReset();
  getOsDndState.mockReset();
  getOsDndState.mockResolvedValue(undefined);
  useNotificationSettingsStore.setState({
    enabled: true,
    hydrated: false,
    completedEnabled: false,
    waitingEnabled: true,
    workingPulseEnabled: false,
    uiFeedbackSoundEnabled: false,
    flashEnabled: false,
    osDndActive: undefined,
  });
  (globalThis as { window?: unknown }).window = {
    electron: {
      notification: { getSettings },
      osDnd: { getState: getOsDndState },
    },
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
      flashEnabled: true,
    });

    await useNotificationSettingsStore.getState().hydrate();

    const s = useNotificationSettingsStore.getState();
    expect(s.completedEnabled).toBe(false);
    expect(s.waitingEnabled).toBe(true);
    expect(s.workingPulseEnabled).toBe(true);
    expect(s.uiFeedbackSoundEnabled).toBe(true);
    expect(s.flashEnabled).toBe(true);
    expect(s.hydrated).toBe(true);
  });

  it("applies defensive defaults matching the main-process store when IPC omits the fields", async () => {
    // Mirrors electron/store.ts: completed off, waiting on, sounds off.
    getSettings.mockResolvedValue({ enabled: true });

    await useNotificationSettingsStore.getState().hydrate();

    const s = useNotificationSettingsStore.getState();
    expect(s.completedEnabled).toBe(false);
    expect(s.waitingEnabled).toBe(true);
    expect(s.workingPulseEnabled).toBe(false);
    expect(s.uiFeedbackSoundEnabled).toBe(false);
    expect(s.flashEnabled).toBe(false);
  });

  it("marks hydrated and preserves defaults when getSettings rejects", async () => {
    getSettings.mockRejectedValue(new Error("ipc down"));

    await useNotificationSettingsStore.getState().hydrate();

    const s = useNotificationSettingsStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.completedEnabled).toBe(false);
    expect(s.waitingEnabled).toBe(true);
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

describe("notificationSettingsStore — osDndActive", () => {
  it("defaults to undefined before hydrate so consumers treat it as unknown", () => {
    expect(useNotificationSettingsStore.getState().osDndActive).toBeUndefined();
  });

  it("hydrates osDndActive from the IPC snapshot", async () => {
    getSettings.mockResolvedValue({ enabled: true });
    getOsDndState.mockResolvedValue(true);

    await useNotificationSettingsStore.getState().hydrate();

    expect(useNotificationSettingsStore.getState().osDndActive).toBe(true);
  });

  it("preserves a push update that arrived before hydration resolved", async () => {
    // Simulate a push event landing first — common when the renderer mounts
    // mid-DND-transition. Hydration must not clobber the fresh value.
    let resolveSettings: ((v: { enabled: true }) => void) | undefined;
    const settingsPromise = new Promise<{ enabled: true }>((r) => {
      resolveSettings = r;
    });
    getSettings.mockReturnValue(settingsPromise);
    getOsDndState.mockResolvedValue(false);

    const hydratePromise = useNotificationSettingsStore.getState().hydrate();

    // Push lands before either IPC resolves.
    useNotificationSettingsStore.getState().setOsDndActive(true);

    resolveSettings?.({ enabled: true });
    await hydratePromise;

    expect(useNotificationSettingsStore.getState().osDndActive).toBe(true);
  });

  it("setOsDndActive accepts true, false, and undefined", () => {
    const { setOsDndActive } = useNotificationSettingsStore.getState();
    setOsDndActive(true);
    expect(useNotificationSettingsStore.getState().osDndActive).toBe(true);
    setOsDndActive(false);
    expect(useNotificationSettingsStore.getState().osDndActive).toBe(false);
    setOsDndActive(undefined);
    expect(useNotificationSettingsStore.getState().osDndActive).toBeUndefined();
  });

  it("treats an IPC failure as a no-op — osDndActive stays at its prior value", async () => {
    getSettings.mockResolvedValue({ enabled: true });
    getOsDndState.mockRejectedValue(new Error("ipc down"));

    useNotificationSettingsStore.setState({ osDndActive: true });
    await useNotificationSettingsStore.getState().hydrate();

    expect(useNotificationSettingsStore.getState().osDndActive).toBe(true);
  });
});
