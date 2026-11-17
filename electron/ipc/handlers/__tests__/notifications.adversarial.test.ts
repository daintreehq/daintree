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
  setSelectedWorktree: vi.fn(),
  acknowledgeWaiting: vi.fn(),
  acknowledgeWorkingPulse: vi.fn(),
  setSessionMuteUntil: vi.fn(),
  removeOwner: vi.fn(),
}));

const soundServiceMock = vi.hoisted(() => ({
  previewFile: vi.fn(),
  play: vi.fn(),
}));

const soundModuleMock = vi.hoisted(() => ({
  soundService: soundServiceMock,
  ALLOWED_SOUND_FILES: new Set(["completed.mp3", "waiting.mp3", "escalation.mp3"]),
  // Imports are playable too, though never in the bundled set.
  PLAYABLE_SOUND_FILES: new Set([
    "completed.mp3",
    "waiting.mp3",
    "escalation.mp3",
    "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f",
  ]),
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

import { registerNotificationHandlers, setNotificationHostRelay } from "../notifications.js";
import { getIpcDispatcher } from "../../dispatcher.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import { onNotificationSettingsWritten } from "../../../utils/notificationSettingsPatch.js";

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

    // Nothing in the patch survives validation, so nothing is written at all.
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("settingsSet tells the settings' followers after a write, and not when nothing was written (#17240)", async () => {
    const heard = vi.fn(() => storeMock.set.mock.calls.length);
    const off = onNotificationSettingsWritten(heard);
    try {
      await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
        completedSoundFile: "../../secret.wav",
      });
      expect(heard).not.toHaveBeenCalled();

      await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), { enabled: false });
      // Heard once the write is in the store, so a follower reads the new value.
      expect(heard).toHaveBeenCalledTimes(1);
      expect(heard.mock.results[0]!.value).toBe(1);
    } finally {
      off();
    }
  });

  it("settingsSet accepts allowed sound file names", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      completedSoundFile: "waiting.mp3",
    });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("notificationSettings", {
      ...defaultSettings,
      completedSoundFile: "waiting.mp3",
    });
  });

  it("settingsSet and preview accept an import this device has, not just bundled files", async () => {
    const id = "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f";
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), { waitingSoundFile: id });
    await getHandler(CHANNELS.NOTIFICATION_PLAY_SOUND)(fakeEvent(), id);

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("notificationSettings", {
      ...defaultSettings,
      waitingSoundFile: id,
    });
    expect(soundServiceMock.previewFile).toHaveBeenCalledWith(id);
  });

  it("settingsSet writes a multi-field patch once, keeping untouched fields and dropping rejected ones (#17026)", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      enabled: false,
      soundEnabled: true,
      waitingSoundFile: "waiting.mp3",
      escalationSoundFile: "/etc/passwd",
      waitingEscalationEnabled: true,
      flashEnabled: false,
    });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("notificationSettings", {
      enabled: false,
      uiFeedbackSoundEnabled: true,
      completedSoundFile: "completed.mp3",
      soundEnabled: true,
      waitingSoundFile: "waiting.mp3",
      waitingEscalationEnabled: true,
      flashEnabled: false,
    });
  });

  it("settingsSet clamps waitingEscalationDelayMs below 30s up to 30s", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: 0,
    });
    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "notificationSettings",
      expect.objectContaining({ waitingEscalationDelayMs: 30_000 })
    );
  });

  it("settingsSet clamps waitingEscalationDelayMs above 1h down to 1h", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: 3_600_001,
    });
    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "notificationSettings",
      expect.objectContaining({ waitingEscalationDelayMs: 3_600_000 })
    );
  });

  it("settingsSet rejects non-finite escalation delay (NaN, Infinity)", async () => {
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: Number.NaN,
    });
    await getHandler(CHANNELS.NOTIFICATION_SETTINGS_SET)(fakeEvent(), {
      waitingEscalationDelayMs: Number.POSITIVE_INFINITY,
    });

    expect(storeMock.set).not.toHaveBeenCalled();
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

  it("playUiEvent is gated on soundEnabled=false even when uiFeedbackSoundEnabled=true (#12185)", async () => {
    storeMock.get.mockReturnValue({
      ...defaultSettings,
      soundEnabled: false,
      uiFeedbackSoundEnabled: true,
    });

    await getHandler(CHANNELS.SOUND_PLAY_UI_EVENT)(fakeEvent(), "click");
    expect(soundServiceMock.play).not.toHaveBeenCalled();
  });

  it("playUiEvent plays when both soundEnabled and uiFeedbackSoundEnabled are true", async () => {
    storeMock.get.mockReturnValue({
      ...defaultSettings,
      soundEnabled: true,
      uiFeedbackSoundEnabled: true,
    });

    await getHandler(CHANNELS.SOUND_PLAY_UI_EVENT)(fakeEvent(), "click");
    expect(soundServiceMock.play).toHaveBeenCalledWith("click");
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

  it("syncWatched records the sending view's selected worktree, null included", async () => {
    const listener = getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED);
    listener(fakeEvent(createSender(7)) as Electron.IpcMainEvent, ["a"], {
      activeWorktreeId: "/repo/wt-a",
    });
    listener(fakeEvent(createSender(8)) as Electron.IpcMainEvent, [], { activeWorktreeId: null });

    await drainMicrotasks();
    expect(agentNotificationServiceMock.setSelectedWorktree).toHaveBeenNthCalledWith(
      1,
      7,
      "/repo/wt-a"
    );
    expect(agentNotificationServiceMock.setSelectedWorktree).toHaveBeenNthCalledWith(2, 8, null);
  });

  it("syncWatched leaves the last selection standing when none, or a malformed one, comes with it", async () => {
    const listener = getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED);
    const event = fakeEvent(createSender(7)) as Electron.IpcMainEvent;
    listener(event, ["a"]);
    listener(event, ["a"], { activeWorktreeId: 42 });
    listener(event, ["a"], { activeWorktreeId: "" });
    listener(event, ["a"], "wt-a");

    await drainMicrotasks();
    expect(agentNotificationServiceMock.syncWatchedPanels).toHaveBeenCalledTimes(4);
    expect(agentNotificationServiceMock.setSelectedWorktree).not.toHaveBeenCalled();
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
        { waitingPanelIds: ["t-1", "t-2", "t-3"] }
      );

      expect(notificationServiceMock.updateNotifications).toHaveBeenCalledWith(42, {
        waitingPanelIds: ["t-1", "t-2", "t-3"],
      });
    });

    it("takes each waiting pane once and drops anything that isn't a panel id", () => {
      getListener(CHANNELS.NOTIFICATION_UPDATE)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { waitingPanelIds: ["t-1", 7, "", null, "t-1", "t-2"] }
      );

      expect(notificationServiceMock.updateNotifications).toHaveBeenCalledWith(42, {
        waitingPanelIds: ["t-1", "t-2"],
      });
    });

    it("keeps every pane of a large report whole", () => {
      const ids = Array.from({ length: 5000 }, (_, i) => `t-${i}`);
      getListener(CHANNELS.NOTIFICATION_UPDATE)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { waitingPanelIds: ids }
      );

      const [, state] = notificationServiceMock.updateNotifications.mock.calls[0]!;
      expect(state.waitingPanelIds).toEqual(ids);
    });

    it("bounds what a runaway report makes it read, junk included", () => {
      const junk = Array.from({ length: 20_000 }, () => 0);
      getListener(CHANNELS.NOTIFICATION_UPDATE)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { waitingPanelIds: [...junk, "t-late"] }
      );

      expect(notificationServiceMock.updateNotifications).toHaveBeenCalledWith(42, {
        waitingPanelIds: [],
      });
    });

    it("drops an id longer than any panel's", () => {
      getListener(CHANNELS.NOTIFICATION_UPDATE)(
        fakeEvent(createSender(42)) as Electron.IpcMainEvent,
        { waitingPanelIds: ["t-1", "x".repeat(5000)] }
      );

      expect(notificationServiceMock.updateNotifications).toHaveBeenCalledWith(42, {
        waitingPanelIds: ["t-1"],
      });
    });

    it("carries a report marked membership-only, and nothing else that claims it", () => {
      const event = fakeEvent(createSender(42)) as Electron.IpcMainEvent;
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, {
        waitingPanelIds: ["t-2"],
        membershipOnly: true,
      });
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, {
        waitingPanelIds: ["t-3"],
        membershipOnly: "yes",
      });

      expect(notificationServiceMock.updateNotifications.mock.calls).toEqual([
        [42, { waitingPanelIds: ["t-2"], membershipOnly: true }],
        [42, { waitingPanelIds: ["t-3"] }],
      ]);
    });

    it("keeps a view's last report through a malformed one, and clears it on an empty one", () => {
      const event = fakeEvent(createSender(42)) as Electron.IpcMainEvent;
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingPanelIds: ["t-1"] });
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingCount: 0 });
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingPanelIds: [] });

      expect(notificationServiceMock.updateNotifications.mock.calls).toEqual([
        [42, { waitingPanelIds: ["t-1"] }],
        [42, { waitingPanelIds: [] }],
      ]);
    });

    it.each([null, 3, "t-1", {}, { waitingCount: 3 }, { waitingPanelIds: "t-1" }])(
      "ignores a badge update that names no panes: %j",
      (payload) => {
        getListener(CHANNELS.NOTIFICATION_UPDATE)(
          fakeEvent(createSender(42)) as Electron.IpcMainEvent,
          payload
        );

        expect(notificationServiceMock.updateNotifications).not.toHaveBeenCalled();
      }
    );

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
        waitingPanelIds: ["t-1"],
      });

      sender.destroy();
      await drainMicrotasks();

      expect(notificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
      expect(agentNotificationServiceMock.removeOwner).toHaveBeenCalledWith(42);
    });

    it("tracks each owner's destroy listener exactly once", () => {
      const sender = createSender(42);
      const event = fakeEvent(sender) as Electron.IpcMainEvent;

      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingPanelIds: ["t-1"] });
      getListener(CHANNELS.NOTIFICATION_UPDATE)(event, { waitingPanelIds: ["t-1", "t-2"] });
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
        { waitingPanelIds: ["t-1"] }
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

  describe("remote views", () => {
    function remoteContext(handle: number) {
      const closers: Array<() => void> = [];
      return {
        closers,
        ctx: {
          event: null,
          senderWindow: null,
          webContentsId: handle,
          projectId: "p1",
          endpoint: {
            kind: "remote-view",
            isClosed: () => false,
            onClose: (cb: () => void) => {
              closers.push(cb);
              return { dispose: () => undefined };
            },
          },
          client: { clientId: "c", kind: "remote" },
        },
      };
    }

    function linkListener(channel: string) {
      const spy = vi.spyOn(getIpcDispatcher(), "registerSend");
      cleanup();
      cleanup = registerNotificationHandlers({} as HandlerDependencies);
      const call = spy.mock.calls.find(([registered]) => registered === channel);
      spy.mockRestore();
      if (!call) throw new Error(`no link listener for ${channel}`);
      return call[1] as (ctx: unknown, ...args: unknown[]) => void;
    }

    it("tracks a remote view's watched panels under its endpoint handle", async () => {
      const { ctx, closers } = remoteContext(-3);
      linkListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(ctx, ["t1", 2]);
      await drainMicrotasks();
      expect(agentNotificationServiceMock.syncWatchedPanels).toHaveBeenCalledWith(-3, ["t1"]);

      closers.forEach((close) => close());
      await drainMicrotasks();
      expect(agentNotificationServiceMock.removeOwner).toHaveBeenCalledWith(-3);
    });

    it("acknowledges a remote view's waiting agent", async () => {
      linkListener(CHANNELS.NOTIFICATION_WAITING_ACKNOWLEDGE)(remoteContext(-3).ctx, {
        terminalId: "t9",
      });
      await drainMicrotasks();
      expect(agentNotificationServiceMock.acknowledgeWaiting).toHaveBeenCalledWith("t9");
    });

    it("hands a remote-bound view's sync to its host instead of acting here", async () => {
      const relay = vi.fn(() => true);
      const release = setNotificationHostRelay(relay);
      getListener(CHANNELS.NOTIFICATION_SYNC_WATCHED)(
        fakeEvent(createSender(5)) as Electron.IpcMainEvent,
        ["t1"]
      );
      await drainMicrotasks();
      release();
      expect(relay).toHaveBeenCalledWith(5, CHANNELS.NOTIFICATION_SYNC_WATCHED, [["t1"]]);
      expect(agentNotificationServiceMock.syncWatchedPanels).not.toHaveBeenCalled();
    });

    it("applies a session mute here and also relays it to the view's host", async () => {
      const relay = vi.fn(() => true);
      const release = setNotificationHostRelay(relay);
      const payload = { timestampMs: 1_700_000_000_000 };
      getListener(CHANNELS.NOTIFICATION_SESSION_MUTE_SET)(
        fakeEvent(createSender(5)) as Electron.IpcMainEvent,
        payload
      );
      await drainMicrotasks();
      release();
      expect(relay).toHaveBeenCalledWith(5, CHANNELS.NOTIFICATION_SESSION_MUTE_SET, [payload]);
      // This machine's own mute: no client scope.
      expect(agentNotificationServiceMock.setSessionMuteUntil).toHaveBeenCalledWith(
        1_700_000_000_000,
        undefined
      );
    });

    it("relays nothing for a malformed session mute", async () => {
      const relay = vi.fn(() => true);
      const release = setNotificationHostRelay(relay);
      getListener(CHANNELS.NOTIFICATION_SESSION_MUTE_SET)(
        fakeEvent(createSender(5)) as Electron.IpcMainEvent,
        { timestampMs: Number.NaN }
      );
      await drainMicrotasks();
      release();
      expect(relay).not.toHaveBeenCalled();
      expect(agentNotificationServiceMock.setSessionMuteUntil).not.toHaveBeenCalled();
    });

    it("scopes a remote Shell's session mute to that Shell's client, never host-wide", async () => {
      linkListener(CHANNELS.NOTIFICATION_SESSION_MUTE_SET)(remoteContext(-3).ctx, {
        timestampMs: 42,
      });
      await drainMicrotasks();
      expect(agentNotificationServiceMock.setSessionMuteUntil).toHaveBeenCalledTimes(1);
      expect(agentNotificationServiceMock.setSessionMuteUntil).toHaveBeenCalledWith(42, "c");
    });
  });
});
