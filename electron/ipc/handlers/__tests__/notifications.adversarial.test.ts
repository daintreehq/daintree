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
  removeOwner: vi.fn(),
}));

const agentNotificationServiceMock = vi.hoisted(() => ({
  syncWatchedPanels: vi.fn(),
  acknowledgeWaiting: vi.fn(),
  acknowledgeWorkingPulse: vi.fn(),
  removeOwner: vi.fn(),
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

/**
 * A sender stands in for a project view's renderer. Its `id` is the owner key,
 * and `destroy()` fires the one-shot listener the handlers use to purge it.
 */
function createSender(id: number) {
  const destroyListeners: Array<() => void> = [];
  return {
    id,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") destroyListeners.push(listener);
    }),
    destroy: () => destroyListeners.splice(0).forEach((fn) => fn()),
  };
}

type Sender = ReturnType<typeof createSender>;

function fakeEvent(sender: Sender = createSender(1)): Electron.IpcMainInvokeEvent {
  return { sender: sender as unknown as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

/** A window whose `cleanup` store the handlers register an owner purge into. */
function createWindowRegistryMock() {
  const disposables: Array<{ dispose: () => void }> = [];
  return {
    registry: {
      getByWebContentsId: vi.fn(() => ({
        cleanup: { add: (d: { dispose: () => void }) => disposables.push(d) },
      })),
    },
    closeWindow: () => disposables.splice(0).forEach((d) => d.dispose()),
  };
}

const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

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
    getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(
      fakeEvent(createSender(7)) as Electron.IpcMainEvent,
      ["a", 1, null, "b", { id: "nope" }]
    );

    // Listener uses fire-and-forget dynamic import — await microtask drain
    await drainMicrotasks();
    expect(agentNotificationServiceMock.syncWatchedPanels).toHaveBeenCalledWith(7, ["a", "b"]);
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

  // #11110 — every handler used to discard `_event`, so main had no idea which
  // renderer reported what and the last caller overwrote everyone else.
  describe("owner attribution", () => {
    it("attributes a badge update to the sending renderer", () => {
      getListener(CHANNELS.NOTIFICATION_UPDATE)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { waitingCount: 3 }
      );

      expect(notificationServiceMock.updateNotifications).toHaveBeenCalledWith(42, {
        waitingCount: 3,
      });
    });

    it("attributes a watch notification to the sending renderer", () => {
      getListener(CHANNELS.NOTIFICATION_SHOW_WATCH)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { title: "T", body: "B", panelId: "p-1" }
      );

      expect(notificationServiceMock.showWatchNotification).toHaveBeenCalledWith(
        "T",
        "B",
        expect.objectContaining({ panelId: "p-1" }),
        CHANNELS.NOTIFICATION_WATCH_NAVIGATE,
        { ownerWebContentsId: 42 }
      );
    });

    it("keeps two renderers' syncs independent", async () => {
      getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(
        fakeEvent(createSender(1)) as Electron.IpcMainEvent,
        ["term-1"]
      );
      getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(
        fakeEvent(createSender(2)) as Electron.IpcMainEvent,
        []
      );
      await drainMicrotasks();

      expect(agentNotificationServiceMock.syncWatchedPanels).toHaveBeenNthCalledWith(1, 1, [
        "term-1",
      ]);
      expect(agentNotificationServiceMock.syncWatchedPanels).toHaveBeenNthCalledWith(2, 2, []);
    });
  });

  describe("owner lifecycle", () => {
    it("purges an owner from both services when its renderer is destroyed", async () => {
      const sender = createSender(42);
      getListener(CHANNELS.NOTIFICATION_UPDATE)(fakeEvent(sender) as Electron.IpcMainEvent, {
        waitingCount: 3,
      });

      sender.destroy();
      await drainMicrotasks();

      expect(notificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
      expect(agentNotificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
    });

    it("tracks each owner's destroy listener exactly once", () => {
      const sender = createSender(42);
      const event = fakeEvent(sender) as Electron.IpcMainEvent;

      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingCount: 1 });
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingCount: 2 });
      getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(event, ["term-1"]);

      expect(sender.once).toHaveBeenCalledTimes(1);
    });

    it("purges the owner when its window tears down", async () => {
      cleanup();
      const { registry, closeWindow } = createWindowRegistryMock();
      cleanup = registerNotificationHandlers({
        windowRegistry: registry,
      } as unknown as HandlerDependencies);

      getListener(CHANNELS.NOTIFICATION_UPDATE)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { waitingCount: 3 }
      );

      closeWindow();
      await drainMicrotasks();

      expect(notificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
      expect(agentNotificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
    });

    it("does not resurrect a destroyed owner with a sync that lands late", async () => {
      const sender = createSender(42);

      // The service import is async: destroy the sender before it settles.
      getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(fakeEvent(sender) as Electron.IpcMainEvent, [
        "term-1",
      ]);
      sender.destroy();
      await drainMicrotasks();

      expect(agentNotificationServiceMock.syncWatchedPanels).not.toHaveBeenCalled();
      expect(agentNotificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
    });
  });
});
