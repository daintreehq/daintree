import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type {
  SystemMemoryPressureDelivery,
  SystemMemoryPressurePayload,
} from "../../../shared/types/ipc/system.js";

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
}));

const appWebContentsByWindow = new Map<number, WebContents>();
vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: (win: BrowserWindow) => appWebContentsByWindow.get(win.id),
}));

import { broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  deliverOpenSystemMemoryPressure,
  getOpenSystemMemoryPressure,
  noteSystemMemoryNoticeShown,
  publishSystemMemoryPressure,
  resetSystemMemoryPressureDeliveryForTesting,
} from "../systemMemoryPressureDelivery.js";

const DEGRADED: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: 91,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
};
const NORMAL: SystemMemoryPressurePayload = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
};

interface FakeWebContents {
  wc: WebContents;
  send: ReturnType<typeof vi.fn>;
  setLoading: (loading: boolean) => void;
  startLoading: () => void;
}

let nextWebContentsId = 1;
function makeWebContents(): FakeWebContents {
  let loading = false;
  const startListeners: Array<
    (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
  > = [];
  const send = vi.fn();
  const wc = {
    id: nextWebContentsId++,
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    on: (
      event: string,
      listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
    ) => {
      if (event === "did-start-navigation") startListeners.push(listener);
    },
    send,
  } as unknown as WebContents;
  return {
    wc,
    send,
    setLoading: (value) => (loading = value),
    startLoading: () => {
      loading = true;
      for (const listener of startListeners) listener({ isMainFrame: true, isSameDocument: false });
    },
  };
}

function makeWindow(id: number, view: FakeWebContents): BrowserWindow {
  const win = { id, isDestroyed: () => false } as unknown as BrowserWindow;
  appWebContentsByWindow.set(id, view.wc);
  return win;
}

const pushed = (
  payload: SystemMemoryPressurePayload,
  delivery: Partial<SystemMemoryPressureDelivery> = {}
) => [
  CHANNELS.EVENTS_PUSH,
  {
    name: "system:memory-pressure",
    payload: {
      ...payload,
      episodeId: expect.any(String),
      fileInbox: payload.status === "degraded",
      launchNoticeShown: false,
      ...delivery,
    },
  },
];

function lastDelivery(send: ReturnType<typeof vi.fn>): SystemMemoryPressureDelivery {
  return (send.mock.calls.at(-1)?.[1] as { payload: SystemMemoryPressureDelivery }).payload;
}

describe("systemMemoryPressureDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appWebContentsByWindow.clear();
    resetSystemMemoryPressureDeliveryForTesting();
  });

  it("sends the opening edge once to each window's visible view", () => {
    const a = makeWebContents();
    const b = makeWebContents();
    const winA = makeWindow(1, a);
    const winB = makeWindow(2, b);

    publishSystemMemoryPressure(DEGRADED, [winA, winB]);
    // The same view finishing a load must not re-raise it.
    deliverOpenSystemMemoryPressure(winA, a.wc);

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith(...pushed(DEGRADED));
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("re-delivers the open episode to a view that reloaded mid-episode", () => {
    const view = makeWebContents();
    const win = makeWindow(1, view);
    publishSystemMemoryPressure(DEGRADED, [win]);
    expect(view.send).toHaveBeenCalledTimes(1);

    // The reload discards the renderer's copy of the notice with its context.
    view.startLoading();
    view.setLoading(false);
    deliverOpenSystemMemoryPressure(win, view.wc);

    expect(view.send).toHaveBeenCalledTimes(2);
    expect(view.send).toHaveBeenLastCalledWith(...pushed(DEGRADED));
  });

  it("re-delivers the open episode to a view replaced mid-episode", () => {
    const view = makeWebContents();
    const win = makeWindow(1, view);
    publishSystemMemoryPressure(DEGRADED, [win]);

    const replacement = makeWebContents();
    appWebContentsByWindow.set(1, replacement.wc);
    deliverOpenSystemMemoryPressure(win, replacement.wc);

    expect(replacement.send).toHaveBeenCalledWith(...pushed(DEGRADED));
  });

  it("holds the opening edge for a view still loading and sends it once that view is ready", () => {
    const view = makeWebContents();
    view.setLoading(true);
    const win = makeWindow(1, view);

    publishSystemMemoryPressure(DEGRADED, [win]);
    expect(view.send).not.toHaveBeenCalled();

    // did-finish-load fires while Chromium still reports the view as loading.
    deliverOpenSystemMemoryPressure(win, view.wc);
    deliverOpenSystemMemoryPressure(win, view.wc);
    expect(view.send).toHaveBeenCalledTimes(1);
  });

  it("reaches a window that did not exist when the episode opened", () => {
    publishSystemMemoryPressure(DEGRADED, []);

    const view = makeWebContents();
    const win = makeWindow(7, view);
    deliverOpenSystemMemoryPressure(win, view.wc);

    expect(view.send).toHaveBeenCalledWith(...pushed(DEGRADED));
  });

  it("broadcasts the closing edge to every view and stops delivering the episode", () => {
    const view = makeWebContents();
    const win = makeWindow(1, view);
    publishSystemMemoryPressure(DEGRADED, [win]);

    publishSystemMemoryPressure(NORMAL, [win]);
    const late = makeWebContents();
    deliverOpenSystemMemoryPressure(makeWindow(2, late), late.wc);

    expect(broadcastToRenderer).toHaveBeenCalledWith(...pushed(NORMAL));
    expect(view.send).toHaveBeenCalledTimes(1);
    expect(late.send).not.toHaveBeenCalled();
  });

  it("delivers the next episode to a window that saw the previous one", () => {
    const view = makeWebContents();
    const win = makeWindow(1, view);

    publishSystemMemoryPressure(DEGRADED, [win]);
    publishSystemMemoryPressure(NORMAL, [win]);
    publishSystemMemoryPressure(DEGRADED, [win]);

    expect(view.send).toHaveBeenCalledTimes(2);
  });

  it("sends an escalation to the visible view that already has the opening edge (#13529)", () => {
    const view = makeWebContents();
    const win = makeWindow(1, view);
    const escalated: SystemMemoryPressurePayload = {
      ...DEGRADED,
      kernelPressureLevel: "critical",
      escalated: true,
    };

    publishSystemMemoryPressure(DEGRADED, [win]);
    publishSystemMemoryPressure(escalated, [win]);
    // A view loading later gets the latest publish, not the opening one.
    const late = makeWebContents();
    deliverOpenSystemMemoryPressure(makeWindow(2, late), late.wc);

    expect(view.send).toHaveBeenCalledTimes(2);
    expect(view.send).toHaveBeenLastCalledWith(...pushed(escalated));
    expect(late.send).toHaveBeenCalledWith(...pushed(escalated));
    expect(getOpenSystemMemoryPressure()).toEqual(escalated);
  });

  it("retries a window whose send threw", () => {
    const view = makeWebContents();
    view.send.mockImplementationOnce(() => {
      throw new Error("render frame disposed");
    });
    const win = makeWindow(1, view);

    publishSystemMemoryPressure(DEGRADED, [win]);
    deliverOpenSystemMemoryPressure(win, view.wc);

    expect(view.send).toHaveBeenCalledTimes(2);
  });

  it("exposes the open episode until it closes", () => {
    const win = makeWindow(1, makeWebContents());
    expect(getOpenSystemMemoryPressure()).toBeNull();

    publishSystemMemoryPressure(DEGRADED, [win]);
    expect(getOpenSystemMemoryPressure()).toEqual(DEGRADED);

    publishSystemMemoryPressure(NORMAL, [win]);
    expect(getOpenSystemMemoryPressure()).toBeNull();
  });

  describe("once-per-episode surfaces (#18274)", () => {
    const CRITICAL: SystemMemoryPressurePayload = {
      ...DEGRADED,
      kernelPressureLevel: "critical",
      escalated: true,
    };

    it("keeps one episode id through escalations and gives a reopened episode a new one", () => {
      const view = makeWebContents();
      const win = makeWindow(1, view);

      publishSystemMemoryPressure(DEGRADED, [win]);
      const first = lastDelivery(view.send).episodeId;
      publishSystemMemoryPressure(CRITICAL, [win]);
      expect(lastDelivery(view.send).episodeId).toBe(first);

      publishSystemMemoryPressure(NORMAL, [win]);
      // The closing edge names the episode it closes.
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        ...pushed(NORMAL, { episodeId: first, fileInbox: false })
      );

      publishSystemMemoryPressure(DEGRADED, [win]);
      const reopened = lastDelivery(view.send).episodeId;
      expect(reopened).toEqual(expect.any(String));
      expect(reopened).not.toBe(first);
    });

    it("asks every view to file the inbox row until one reports it, then no view shown later files it", () => {
      const a = makeWebContents();
      const b = makeWebContents();
      const winA = makeWindow(1, a);
      const winB = makeWindow(2, b);

      // Both visible views are asked, so the attended one can toast.
      publishSystemMemoryPressure(DEGRADED, [winA, winB]);
      expect(lastDelivery(a.send).fileInbox).toBe(true);
      expect(lastDelivery(b.send).fileInbox).toBe(true);
      const { episodeId } = lastDelivery(a.send);

      noteSystemMemoryNoticeShown(episodeId!, "inbox-warning", [winA, winB]);

      // A project switched to later, a reload, and a replacement view all leave
      // the row as the user left it in the shared inbox.
      const cached = makeWebContents();
      deliverOpenSystemMemoryPressure(winA, cached.wc);
      expect(cached.send).toHaveBeenCalledWith(...pushed(DEGRADED, { fileInbox: false }));
      a.startLoading();
      a.setLoading(false);
      deliverOpenSystemMemoryPressure(winA, a.wc);
      expect(lastDelivery(a.send).fileInbox).toBe(false);

      // A worsening at the same level refreshes the row rather than filing one.
      publishSystemMemoryPressure({ ...DEGRADED, swapUsedPercent: 95, escalated: true }, [winA]);
      expect(lastDelivery(a.send).fileInbox).toBe(false);
    });

    it("files the first critical level once more, and drops a report for a level the episode passed", () => {
      const view = makeWebContents();
      const win = makeWindow(1, view);

      publishSystemMemoryPressure(DEGRADED, [win]);
      const { episodeId } = lastDelivery(view.send);
      noteSystemMemoryNoticeShown(episodeId!, "inbox-warning", [win]);

      publishSystemMemoryPressure(CRITICAL, [win]);
      expect(lastDelivery(view.send).fileInbox).toBe(true);

      // A warning-level report landing after the critical publish is stale.
      noteSystemMemoryNoticeShown(episodeId!, "inbox-warning", [win]);
      const late = makeWebContents();
      deliverOpenSystemMemoryPressure(makeWindow(2, late), late.wc);
      expect(lastDelivery(late.send).fileInbox).toBe(true);

      noteSystemMemoryNoticeShown(episodeId!, "inbox-critical", [win]);
      const later = makeWebContents();
      deliverOpenSystemMemoryPressure(makeWindow(3, later), later.wc);
      expect(lastDelivery(later.send).fileInbox).toBe(false);
    });

    it("tells every view once a launch bar was shown, visible ones now and cached ones on reveal", () => {
      const a = makeWebContents();
      const b = makeWebContents();
      const winA = makeWindow(1, a);
      const winB = makeWindow(2, b);
      publishSystemMemoryPressure(DEGRADED, [winA, winB]);
      const { episodeId } = lastDelivery(a.send);

      noteSystemMemoryNoticeShown(episodeId!, "launch-bar", [winA, winB]);

      expect(a.send).toHaveBeenCalledTimes(2);
      expect(lastDelivery(a.send).launchNoticeShown).toBe(true);
      expect(lastDelivery(b.send).launchNoticeShown).toBe(true);
      const cached = makeWebContents();
      deliverOpenSystemMemoryPressure(winA, cached.wc);
      expect(lastDelivery(cached.send).launchNoticeShown).toBe(true);

      // A repeat report sends nothing new.
      noteSystemMemoryNoticeShown(episodeId!, "launch-bar", [winA, winB]);
      expect(a.send).toHaveBeenCalledTimes(2);
    });

    it("ignores a report for an episode that has closed, and re-arms every surface for the next", () => {
      const view = makeWebContents();
      const win = makeWindow(1, view);
      publishSystemMemoryPressure(DEGRADED, [win]);
      const { episodeId: closed } = lastDelivery(view.send);
      noteSystemMemoryNoticeShown(closed!, "inbox-warning", [win]);
      noteSystemMemoryNoticeShown(closed!, "launch-bar", [win]);
      publishSystemMemoryPressure(NORMAL, [win]);

      publishSystemMemoryPressure(DEGRADED, [win]);
      noteSystemMemoryNoticeShown(closed!, "inbox-warning", [win]);
      noteSystemMemoryNoticeShown(closed!, "launch-bar", [win]);
      const late = makeWebContents();
      deliverOpenSystemMemoryPressure(makeWindow(2, late), late.wc);

      expect(late.send).toHaveBeenCalledWith(
        ...pushed(DEGRADED, { fileInbox: true, launchNoticeShown: false })
      );
    });
  });
});
