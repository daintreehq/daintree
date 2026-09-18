import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type { SystemMemoryPressurePayload } from "../../../shared/types/ipc/system.js";

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
  publishSystemMemoryPressure,
  resetSystemMemoryPressureDeliveryForTesting,
} from "../systemMemoryPressureDelivery.js";

const DEGRADED: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: 91,
  swapKind: "swap",
  fseventsdRssMb: null,
};
const NORMAL: SystemMemoryPressurePayload = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
};

interface FakeWebContents {
  wc: WebContents;
  send: ReturnType<typeof vi.fn>;
  setLoading: (loading: boolean) => void;
}

function makeWebContents(): FakeWebContents {
  let loading = false;
  const send = vi.fn();
  const wc = {
    isDestroyed: () => false,
    isLoading: () => loading,
    send,
  } as unknown as WebContents;
  return { wc, send, setLoading: (value) => (loading = value) };
}

function makeWindow(id: number, view: FakeWebContents): BrowserWindow {
  const win = { id, isDestroyed: () => false } as unknown as BrowserWindow;
  appWebContentsByWindow.set(id, view.wc);
  return win;
}

const pushed = (payload: SystemMemoryPressurePayload) => [
  CHANNELS.EVENTS_PUSH,
  { name: "system:memory-pressure", payload },
];

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
    // A later project view in the same window must not re-raise it.
    const next = makeWebContents();
    deliverOpenSystemMemoryPressure(winA, next.wc);

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(a.send).toHaveBeenCalledWith(...pushed(DEGRADED));
    expect(b.send).toHaveBeenCalledTimes(1);
    expect(next.send).not.toHaveBeenCalled();
  });

  it("holds the opening edge for a view still loading and sends it once that view is ready", () => {
    const view = makeWebContents();
    view.setLoading(true);
    const win = makeWindow(1, view);

    publishSystemMemoryPressure(DEGRADED, [win]);
    expect(view.send).not.toHaveBeenCalled();

    view.setLoading(false);
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
});
