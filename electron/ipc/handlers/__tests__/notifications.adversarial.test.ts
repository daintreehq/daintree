import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: Electron.IpcMainEvent, ...args: unknown[]) => void;
type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

const ipcHandlers = vi.hoisted(() => new Map<string, InvokeHandler>());
const ipcListeners = vi.hoisted(() => new Map<string, Listener>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: InvokeHandler) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
  on: vi.fn((channel: string, fn: Listener) => ipcListeners.set(channel, fn)),
  removeListener: vi.fn((channel: string) => ipcListeners.delete(channel)),
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(),
  set: vi.fn(),
}));

const notificationServiceMock = vi.hoisted(() => ({
  updateNotifications: vi.fn(),
  showNativeNotification: vi.fn(),
  showWatchNotification: vi.fn(),
}));

const agentNotificationServiceMock = vi.hoisted(() => ({
  syncWatchedPanels: vi.fn(),
  acknowledgeWaiting: vi.fn(),
  acknowledgeWorkingPulse: vi.fn(),
}));

const soundServiceMock = vi.hoisted(() => ({
  previewFile: vi.fn(),
  play: vi.fn(),
}));

const soundModuleMock = vi.hoisted(() => ({
  soundService: soundServiceMock,
  ALLOWED_SOUND_FILES: new Set(["completed.mp3", "waiting.mp3", "escalation.mp3"]),
  SOUND_FILES: { click: "click.mp3", error: "error.mp3" },
  getSoundsDir: vi.fn(() => "/sounds"),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/NotificationService.js", () => ({
  notificationService: notificationServiceMock,
}));
vi.mock("../../../services/AgentNotificationService.js", () => ({
  agentNotificationService: agentNotificationServiceMock,
}));
vi.mock("../../../services/SoundService.js", () => soundModuleMock);
vi.mock("../../../store.js", () => ({ store: storeMock }));

import { registerNotificationHandlers } from "../notifications.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

function getHandler(channel: string): InvokeHandler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn;
}

function getListener(channel: string): Listener {
  const fn = ipcListeners.get(channel);
  if (!fn) throw new Error(`listener not registered: ${channel}`);
  return fn;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

const defaultSettings = {
  enabled: true,
  uiFeedbackSoundEnabled: true,
  completedSoundFile: "completed.mp3",
};

describe("notifications IPC adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    ipcListeners.clear();
    vi.clearAllMocks();
    storeMock.get.mockImplementation(() => ({ ...defaultSettings }));
    cleanup = registerNotificationHandlers({} as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("settingsSet drops unsafe sound-file paths (traversal, absolute, unknown)", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      completedSoundFile: "../../secret.wav",
      waitingSoundFile: "/etc/passwd",
      escalationSoundFile: "unknown-file.mp3",
    });

    // Dot-path writes only land for validated fields. Unsafe values must not
    // reach the store at all — assert no call targets any sound-file leaf.
    const writtenKeys = storeMock.set.mock.calls.map((c) => String(c[0]));
    expect(writtenKeys).not.toContain("notificationSettings.completedSoundFile");
    expect(writtenKeys).not.toContain("notificationSettings.waitingSoundFile");
    expect(writtenKeys).not.toContain("notificationSettings.escalationSoundFile");
  });

  it("settingsSet accepts allowed sound file names", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      completedSoundFile: "waiting.mp3",
    });

    expect(storeMock.set).toHaveBeenCalledWith(
      "notificationSettings.completedSoundFile",
      "waiting.mp3"
    );
  });

  it("settingsSet clamps waitingEscalationDelayMs below 30s up to 30s", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: 0,
    });
    expect(storeMock.set).toHaveBeenCalledWith(
      "notificationSettings.waitingEscalationDelayMs",
      30_000
    );
  });

  it("settingsSet clamps waitingEscalationDelayMs above 1h down to 1h", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: 3_600_001,
    });
    expect(storeMock.set).toHaveBeenCalledWith(
      "notificationSettings.waitingEscalationDelayMs",
      3_600_000
    );
  });

  it("settingsSet rejects non-finite escalation delay (NaN, Infinity)", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: Number.NaN,
    });
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: Number.POSITIVE_INFINITY,
    });

    const writtenKeys = storeMock.set.mock.calls.map((c) => String(c[0]));
    expect(writtenKeys).not.toContain("notificationSettings.waitingEscalationDelayMs");
  });

  it("settingsSet ignores non-object payloads silently", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), null);
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), "string");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("playSound rejects unsafe file paths (not in allowlist)", async () => {
    await getHandler(CHANNELS.NOTIFICATION_PLAY_SOUND)(fakeEvent(), "../../traversal.wav");
    await getHandler(CHANNELS.NOTIFICATION_PLAY_SOUND)(fakeEvent(), "/etc/passwd");
    expect(soundServiceMock.previewFile).not.toHaveBeenCalled();
  });

  it("playSound accepts allowed files", async () => {
    await getHandler(CHANNELS.NOTIFICATION_PLAY_SOUND)(fakeEvent(), "completed.mp3");
    expect(soundServiceMock.previewFile).toHaveBeenCalledWith("completed.mp3");
  });

  it("playUiEvent is gated on uiFeedbackSoundEnabled=false", async () => {
    storeMock.get.mockReturnValue({ ...defaultSettings, uiFeedbackSoundEnabled: false });

    await getHandler(CHANNELS.SOUND_PLAY_UI_EVENT)(fakeEvent(), "click");
    expect(soundServiceMock.play).not.toHaveBeenCalled();
  });

  it("playUiEvent rejects unknown sound ids even when enabled", async () => {
    await getHandler(CHANNELS.SOUND_PLAY_UI_EVENT)(fakeEvent(), "unknown-sound");
    expect(soundServiceMock.play).not.toHaveBeenCalled();
  });

  it("syncWatched filters non-string entries from the id array", async () => {
    getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(fakeEvent() as Electron.IpcMainEvent, [
      "a",
      1,
      null,
      "b",
      { id: "nope" },
    ]);

    // Listener uses fire-and-forget dynamic import — await microtask drain
    await new Promise((resolve) => setImmediate(resolve));
    expect(agentNotificationServiceMock.syncWatchedPanels).toHaveBeenCalledWith(["a", "b"]);
  });

  it("syncWatched ignores non-array payload", () => {
    getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(
      fakeEvent() as Electron.IpcMainEvent,
      "not-an-array"
    );
    expect(agentNotificationServiceMock.syncWatchedPanels).not.toHaveBeenCalled();
  });

  it("showWatch falls back panelTitle to panelId when missing", () => {
    getListener(CHANNELS.NOTIFICATION_SHOW_WATCH)(fakeEvent() as Electron.IpcMainEvent, {
      title: "T",
      body: "B",
      panelId: "p-123",
    });

    const [_title, _body, context] = notificationServiceMock.showWatchNotification.mock.calls[0];
    expect((context as { panelTitle: string }).panelTitle).toBe("p-123");
  });

  it("showWatch ignores payload missing required string fields", () => {
    getListener(CHANNELS.NOTIFICATION_SHOW_WATCH)(fakeEvent() as Electron.IpcMainEvent, {
      title: "T",
      body: 42,
      panelId: "p",
    });
    expect(notificationServiceMock.showWatchNotification).not.toHaveBeenCalled();
  });

  it("waitingAcknowledge ignores non-string terminalId", () => {
    getListener(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE)(fakeEvent() as Electron.IpcMainEvent, {
      terminalId: 42,
    });
    expect(agentNotificationServiceMock.acknowledgeWaiting).not.toHaveBeenCalled();
  });

  it("cleanup removes every listener and handler", () => {
    cleanup();
    expect(ipcHandlers.size).toBe(0);
    expect(ipcListeners.size).toBe(0);
  });
});
