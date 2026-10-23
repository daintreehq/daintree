import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ emitter: null as null | import("node:events").EventEmitter }));
vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  ipc.emitter = new Emitter();
  return { ipcMain: ipc.emitter };
});
vi.mock("../../utils/logger.js", () => ({ logError: vi.fn() }));

import { CHANNELS } from "../../ipc/channels.js";
import {
  _resetPanelRecoveryStateForTests,
  installPanelRecoveryStateListener,
  isPanelRecoveryHeldReported,
  onPanelRecoveryHoldReleased,
  readPanelRecoveryHold,
} from "../panelRecoveryQuery.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

let nextContentsId = 1;

class FakeContents extends EventEmitter {
  id = nextContentsId++;
  destroyed = false;
  loading = false;
  sent: string[] = [];
  constructor(private reply: ((requestId: string, self: FakeContents) => void) | null) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isLoadingMainFrame() {
    return this.loading;
  }
  send(_channel: string, requestId: string) {
    this.sent.push(requestId);
    this.reply?.(requestId, this);
  }
}

const answer = (holding: unknown) => (requestId: string, self: FakeContents) =>
  queueMicrotask(() =>
    ipc.emitter!.emit(
      CHANNELS.PROJECT_PANEL_RECOVERY_REPLY,
      { sender: self },
      { requestId, holding }
    )
  );

function manager(views: Array<{ projectId: string; webContents: unknown }>) {
  return {
    getAllViews: () =>
      views.map((v) => ({ projectId: v.projectId, view: { webContents: v.webContents } })),
  } as unknown as ProjectViewManager;
}

describe("readPanelRecoveryHold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    expect(ipc.emitter!.listenerCount(CHANNELS.PROJECT_PANEL_RECOVERY_REPLY)).toBe(0);
  });

  it("clears a project with no resident view", async () => {
    const provider = () => [manager([{ projectId: "other", webContents: new FakeContents(null) }])];
    expect(await readPanelRecoveryHold("p", provider)).toBeNull();
  });

  it("clears when every view answers that it holds nothing", async () => {
    const wc = new FakeContents(answer(false));
    expect(
      await readPanelRecoveryHold("p", () => [manager([{ projectId: "p", webContents: wc }])])
    ).toBeNull();
  });

  it("holds when any window's view reports unrecoverable work", async () => {
    const clean = new FakeContents(answer(false));
    const dirty = new FakeContents(answer(true));
    const result = await readPanelRecoveryHold("p", () => [
      manager([{ projectId: "p", webContents: clean }]),
      manager([{ projectId: "p", webContents: dirty }]),
    ]);
    expect(result).toBe("panel-unrecoverable");
  });

  it("holds a view that never answers once the timeout lapses", async () => {
    const wc = new FakeContents(null);
    const pending = readPanelRecoveryHold("p", () => [
      manager([{ projectId: "p", webContents: wc }]),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe("panel-unknown");
  });

  it("holds on a malformed reply", async () => {
    const wc = new FakeContents(answer("no"));
    expect(
      await readPanelRecoveryHold("p", () => [manager([{ projectId: "p", webContents: wc }])])
    ).toBe("panel-unknown");
  });

  it("ignores a reply from another sender", async () => {
    const wc = new FakeContents((requestId) =>
      queueMicrotask(() =>
        ipc.emitter!.emit(
          CHANNELS.PROJECT_PANEL_RECOVERY_REPLY,
          { sender: {} },
          { requestId, holding: false }
        )
      )
    );
    const pending = readPanelRecoveryHold("p", () => [
      manager([{ projectId: "p", webContents: wc }]),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe("panel-unknown");
  });

  it("holds when the renderer goes away mid-query", async () => {
    const wc = new FakeContents((_id, self) =>
      queueMicrotask(() => self.emit("render-process-gone"))
    );
    expect(
      await readPanelRecoveryHold("p", () => [manager([{ projectId: "p", webContents: wc }])])
    ).toBe("panel-unknown");
  });

  it.each([
    ["destroyed", (wc: FakeContents) => (wc.destroyed = true)],
    ["still loading", (wc: FakeContents) => (wc.loading = true)],
  ])("holds a view that is %s without asking it", async (_name, mutate) => {
    const wc = new FakeContents(answer(false));
    mutate(wc);
    expect(
      await readPanelRecoveryHold("p", () => [manager([{ projectId: "p", webContents: wc }])])
    ).toBe("panel-unknown");
    expect(wc.sent).toEqual([]);
  });

  it("holds a view whose webContents getter returns undefined", async () => {
    expect(
      await readPanelRecoveryHold("p", () => [
        manager([{ projectId: "p", webContents: undefined }]),
      ])
    ).toBe("panel-unknown");
  });

  it("holds when the window list can't be read", async () => {
    expect(
      await readPanelRecoveryHold("p", () => {
        throw new Error("boom");
      })
    ).toBe("panel-unknown");
  });
});

describe("pushed recovery state", () => {
  let uninstall: () => void;
  const push = (wc: FakeContents, holding: unknown) =>
    ipc.emitter!.emit(CHANNELS.PROJECT_PANEL_RECOVERY_STATE, { sender: wc }, holding);
  const held = (wc: FakeContents) =>
    isPanelRecoveryHeldReported(wc as unknown as Electron.WebContents);

  beforeEach(() => {
    _resetPanelRecoveryStateForTests();
    uninstall = installPanelRecoveryStateListener();
  });
  afterEach(() => {
    uninstall();
    expect(ipc.emitter!.listenerCount(CHANNELS.PROJECT_PANEL_RECOVERY_STATE)).toBe(0);
  });

  it("holds nothing for a view that has said nothing yet", () => {
    expect(held(new FakeContents(null))).toBe(false);
  });

  it("reads each view's last answer, apart from every other view's", () => {
    const a = new FakeContents(null);
    const b = new FakeContents(null);
    push(a, true);
    expect(held(a)).toBe(true);
    expect(held(b)).toBe(false);
    push(a, false);
    expect(held(a)).toBe(false);
  });

  it("ignores an answer that is not a boolean", () => {
    const wc = new FakeContents(null);
    push(wc, true);
    push(wc, "yes");
    expect(held(wc)).toBe(true);
  });

  it.each(["destroyed", "render-process-gone"])("forgets a view on %s", (event) => {
    const wc = new FakeContents(null);
    push(wc, true);
    wc.emit(event);
    expect(held(wc)).toBe(false);
    // One teardown listener pair per view, however often it reports.
    push(wc, true);
    push(wc, false);
    push(wc, true);
    expect(wc.listenerCount("destroyed")).toBe(1);
    expect(wc.listenerCount("render-process-gone")).toBe(1);
  });

  it("holds nothing for a destroyed view, whatever it last said", () => {
    const wc = new FakeContents(null);
    push(wc, true);
    wc.destroyed = true;
    expect(held(wc)).toBe(false);
  });

  it("drops a document's answer when the view navigates, and keeps listening", () => {
    const wc = new FakeContents(null);
    push(wc, true);
    wc.emit("did-navigate");
    expect(held(wc)).toBe(false);
    push(wc, true);
    expect(held(wc)).toBe(true);
    expect(wc.listenerCount("did-navigate")).toBe(1);
  });

  it("announces a release only when a held view stops holding", () => {
    const released = vi.fn();
    const off = onPanelRecoveryHoldReleased(released);
    const wc = new FakeContents(null);
    push(wc, false);
    push(wc, true);
    push(wc, true);
    expect(released).not.toHaveBeenCalled();
    push(wc, false);
    expect(released.mock.calls).toEqual([[wc.id]]);
    push(wc, true);
    wc.emit("did-navigate");
    expect(released).toHaveBeenCalledTimes(2);
    // A destroyed view is gone, not released: there is no cap to restore for it.
    push(wc, true);
    wc.emit("destroyed");
    expect(released).toHaveBeenCalledTimes(2);
    off();
  });

  it("stops listening once uninstalled", () => {
    const wc = new FakeContents(null);
    uninstall();
    push(wc, true);
    expect(held(wc)).toBe(false);
    uninstall = installPanelRecoveryStateListener();
  });
});
