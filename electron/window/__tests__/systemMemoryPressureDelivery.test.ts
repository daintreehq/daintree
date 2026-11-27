import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type {
  SystemMemoryPressureDelivery,
  SystemMemoryPressurePayload,
} from "../../../shared/types/ipc/system.js";

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToRemoteEndpoints: vi.fn(),
  sendToWebContents: vi.fn((wc: WebContents, channel: string, ...args: unknown[]) => {
    try {
      wc.send(channel, ...args);
      return true;
    } catch {
      return false;
    }
  }),
}));

const appWebContentsByWindow = new Map<number, WebContents>();
/** Views that exist but no window shows, as a cached project view. */
const cachedWebContents: WebContents[] = [];
vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: (win: BrowserWindow) => appWebContentsByWindow.get(win.id),
  getAllAppWebContents: () => [...appWebContentsByWindow.values(), ...cachedWebContents],
}));

import { broadcastToRemoteEndpoints, broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import {
  deliverOpenSystemMemoryPressure,
  claimSystemMemoryNotice,
  forgetHostSystemMemoryPressure,
  getOpenSystemMemoryPressure,
  publishHostSystemMemoryPressure,
  publishSystemMemoryPressure,
  releaseSystemMemoryNotice,
  refreshSystemMemoryPressure,
  replaySystemMemoryPressureToEndpoint,
  resetSystemMemoryPressureDeliveryForTesting,
  setSystemMemoryPressureRoute,
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
  /** A reload, which commits a new document. */
  startLoading: () => void;
  /** A navigation that starts and never commits, as one the app cancels. */
  startUncommittedNavigation: () => void;
  stopLoading: () => void;
  /** A subframe, or a browser panel's guest, committing a document of its own. */
  commitSubframe: () => void;
}

let nextWebContentsId = 1;
function makeWebContents(): FakeWebContents {
  let loading = false;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const onceListeners = new Map<string, Array<() => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
    const once = onceListeners.get(event) ?? [];
    onceListeners.delete(event);
    for (const listener of once) listener();
  };
  const send = vi.fn();
  const wc = {
    id: nextWebContentsId++,
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    once: (event: string, listener: () => void) => {
      onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
    },
    send,
  } as unknown as WebContents;
  const navigationStart = { isMainFrame: true, isSameDocument: false };
  return {
    wc,
    send,
    setLoading: (value) => (loading = value),
    startLoading: () => {
      loading = true;
      emit("did-start-navigation", navigationStart);
      emit("did-navigate", {}, "app://daintree/index.html");
    },
    startUncommittedNavigation: () => {
      loading = true;
      emit("did-start-navigation", navigationStart);
    },
    stopLoading: () => {
      loading = false;
      emit("did-stop-loading");
    },
    commitSubframe: () => {
      emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "about:blank", false);
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
    cachedWebContents.length = 0;
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

    it("gives the inbox row to the first view that claims it, and stops asking views shown later", () => {
      const a = makeWebContents();
      const b = makeWebContents();
      const winA = makeWindow(1, a);
      const winB = makeWindow(2, b);

      // Both visible views are asked; the first to claim files the row.
      publishSystemMemoryPressure(DEGRADED, [winA, winB]);
      expect(lastDelivery(a.send).fileInbox).toBe(true);
      expect(lastDelivery(b.send).fileInbox).toBe(true);
      const { episodeId } = lastDelivery(a.send);
      expect(claimSystemMemoryNotice(episodeId!, "inbox-warning")).toBe(true);
      // The other, or one replaying a delivery it buffered, is refused.
      expect(claimSystemMemoryNotice(episodeId!, "inbox-warning")).toBe(false);

      // A project switched to later, a reload, and a worsening at the same
      // level all leave the row as the user left it in the shared inbox.
      const cached = makeWebContents();
      deliverOpenSystemMemoryPressure(winA, cached.wc);
      expect(cached.send).toHaveBeenCalledWith(...pushed(DEGRADED, { fileInbox: false }));
      a.startLoading();
      a.setLoading(false);
      deliverOpenSystemMemoryPressure(winA, a.wc);
      expect(lastDelivery(a.send).fileInbox).toBe(false);
      publishSystemMemoryPressure({ ...DEGRADED, swapUsedPercent: 95, escalated: true }, [winA]);
      expect(lastDelivery(a.send).fileInbox).toBe(false);
    });

    it("files the first critical level once more, and refuses a claim for a level the episode passed", () => {
      const view = makeWebContents();
      const win = makeWindow(1, view);

      publishSystemMemoryPressure(DEGRADED, [win]);
      const { episodeId } = lastDelivery(view.send);
      expect(claimSystemMemoryNotice(episodeId!, "inbox-warning")).toBe(true);

      publishSystemMemoryPressure(CRITICAL, [win]);
      expect(lastDelivery(view.send).fileInbox).toBe(true);
      // A warning-level claim from a delivery handled after the critical publish.
      expect(claimSystemMemoryNotice(episodeId!, "inbox-warning")).toBe(false);
      expect(claimSystemMemoryNotice(episodeId!, "inbox-critical")).toBe(true);
      expect(claimSystemMemoryNotice(episodeId!, "inbox-warning")).toBe(false);
      expect(claimSystemMemoryNotice(episodeId!, "inbox-critical")).toBe(false);

      const later = makeWebContents();
      deliverOpenSystemMemoryPressure(makeWindow(3, later), later.wc);
      expect(lastDelivery(later.send).fileInbox).toBe(false);
    });

    it("gives the critical toast once, only at the critical level, and again after a release", () => {
      const view = makeWebContents();
      const win = makeWindow(1, view);
      publishSystemMemoryPressure(DEGRADED, [win]);
      const { episodeId } = lastDelivery(view.send);
      expect(claimSystemMemoryNotice(episodeId!, "critical-toast")).toBe(false);

      publishSystemMemoryPressure(CRITICAL, [win]);
      expect(claimSystemMemoryNotice(episodeId!, "critical-toast")).toBe(true);
      expect(claimSystemMemoryNotice(episodeId!, "critical-toast")).toBe(false);

      // Quiet hours held the toast back, so the next attended view may show it.
      releaseSystemMemoryNotice(episodeId!, "critical-toast");
      expect(claimSystemMemoryNotice(episodeId!, "critical-toast")).toBe(true);
    });

    it("gives the launch bar once, and again after a release", () => {
      publishSystemMemoryPressure(DEGRADED, [makeWindow(1, makeWebContents())]);
      const episodeId = (
        vi.mocked(appWebContentsByWindow.get(1)!.send).mock.calls.at(-1)?.[1] as {
          payload: SystemMemoryPressureDelivery;
        }
      ).payload.episodeId!;

      expect(claimSystemMemoryNotice(episodeId, "launch-bar")).toBe(true);
      expect(claimSystemMemoryNotice(episodeId, "launch-bar")).toBe(false);
      releaseSystemMemoryNotice(episodeId, "launch-bar");
      expect(claimSystemMemoryNotice(episodeId, "launch-bar")).toBe(true);
    });

    it("refuses claims for an episode that has closed, and re-arms every surface for the next", () => {
      const view = makeWebContents();
      const win = makeWindow(1, view);
      publishSystemMemoryPressure(CRITICAL, [win]);
      const { episodeId: closed } = lastDelivery(view.send);
      for (const surface of ["inbox-critical", "critical-toast", "launch-bar"] as const) {
        expect(claimSystemMemoryNotice(closed!, surface)).toBe(true);
      }
      publishSystemMemoryPressure(NORMAL, [win]);
      expect(claimSystemMemoryNotice(closed!, "launch-bar")).toBe(false);

      publishSystemMemoryPressure(CRITICAL, [win]);
      const { episodeId: next } = lastDelivery(view.send);
      // A late release from the closed episode leaves the new one's claims alone.
      expect(claimSystemMemoryNotice(next!, "launch-bar")).toBe(true);
      releaseSystemMemoryNotice(closed!, "launch-bar");
      expect(claimSystemMemoryNotice(next!, "launch-bar")).toBe(false);
      expect(claimSystemMemoryNotice(closed!, "inbox-critical")).toBe(false);
      for (const surface of ["inbox-critical", "critical-toast"] as const) {
        expect(claimSystemMemoryNotice(next!, surface)).toBe(true);
      }
    });
  });
});

describe("systemMemoryPressureDelivery across machines (#18275)", () => {
  const STUDIO = { id: "host-studio", name: "Studio" };
  const BUILD_BOX = { id: "host-build", name: "Build box" };
  const STUDIO_EPISODE: SystemMemoryPressurePayload = {
    ...DEGRADED,
    swapUsedPercent: 64,
    workloads: { appMemoryMb: 900, projects: [], agentsRunning: 2, memoryTotalMb: 32768 },
    host: STUDIO,
  };
  const BUILD_BOX_EPISODE: SystemMemoryPressurePayload = {
    ...DEGRADED,
    swapUsedPercent: 88,
    host: BUILD_BOX,
  };
  const routes = new Map<number, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    appWebContentsByWindow.clear();
    cachedWebContents.length = 0;
    routes.clear();
    resetSystemMemoryPressureDeliveryForTesting();
    setSystemMemoryPressureRoute((webContentsId) => routes.get(webContentsId) ?? null);
  });

  function remoteView(hostId: string): FakeWebContents {
    const view = makeWebContents();
    routes.set(view.wc.id, hostId);
    return view;
  }

  it("keeps this machine's episode from a window attached to a host", () => {
    const local = makeWebContents();
    const remote = remoteView(STUDIO.id);
    const windows = [makeWindow(1, local), makeWindow(2, remote)];

    publishSystemMemoryPressure(DEGRADED, windows);
    // Its loads replay what its host said, which is nothing yet.
    deliverOpenSystemMemoryPressure(windows[1]!, remote.wc);

    expect(local.send).toHaveBeenCalledWith(...pushed(DEGRADED));
    expect(remote.send).not.toHaveBeenCalled();
  });

  it("shows a window attached to a host that host's episode, not this machine's", () => {
    const local = makeWebContents();
    const remote = remoteView(STUDIO.id);
    const windows = [makeWindow(1, local), makeWindow(2, remote)];

    publishSystemMemoryPressure(DEGRADED, windows);
    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, windows);

    expect(remote.send.mock.calls).toEqual([pushed(STUDIO_EPISODE)]);
    expect(local.send.mock.calls).toEqual([pushed(DEGRADED)]);
    expect(getOpenSystemMemoryPressure()).toEqual(DEGRADED);
  });

  it("takes claims against a host's episode under the id its host gave it, apart from this machine's", () => {
    const local = makeWebContents();
    const studio = remoteView(STUDIO.id);
    const windows = [makeWindow(1, local), makeWindow(2, studio)];

    publishSystemMemoryPressure(DEGRADED, windows);
    publishHostSystemMemoryPressure(
      STUDIO.id,
      { ...STUDIO_EPISODE, episodeId: "studio-episode-1" },
      windows
    );
    const localId = lastDelivery(local.send).episodeId!;
    expect(lastDelivery(studio.send)).toMatchObject({
      episodeId: "studio-episode-1",
      fileInbox: true,
    });

    expect(claimSystemMemoryNotice(localId, "inbox-warning")).toBe(true);
    // Filing this machine's row leaves the host's still owed.
    expect(claimSystemMemoryNotice("studio-episode-1", "inbox-warning")).toBe(true);
    expect(claimSystemMemoryNotice("studio-episode-1", "inbox-warning")).toBe(false);
    expect(claimSystemMemoryNotice("studio-episode-1", "launch-bar")).toBe(true);
    releaseSystemMemoryNotice("studio-episode-1", "launch-bar");
    expect(claimSystemMemoryNotice("studio-episode-1", "launch-bar")).toBe(true);

    // A host's escalation keeps the claims its episode has had.
    const later = makeWebContents();
    routes.set(later.wc.id, STUDIO.id);
    publishHostSystemMemoryPressure(
      STUDIO.id,
      { ...STUDIO_EPISODE, swapUsedPercent: 80, escalated: true, episodeId: "studio-episode-1" },
      [makeWindow(3, later)]
    );
    expect(lastDelivery(later.send)).toMatchObject({ fileInbox: false });

    publishHostSystemMemoryPressure(
      STUDIO.id,
      { ...NORMAL, host: STUDIO, episodeId: "studio-episode-1" },
      windows
    );
    expect(lastDelivery(studio.send)).toMatchObject({
      status: "normal",
      episodeId: "studio-episode-1",
      fileInbox: false,
    });
    expect(claimSystemMemoryNotice("studio-episode-1", "launch-bar")).toBe(false);
  });

  it("keeps two hosts' episodes apart as each opens, worsens and recovers", () => {
    const studio = remoteView(STUDIO.id);
    const buildBox = remoteView(BUILD_BOX.id);
    const windows = [makeWindow(1, studio), makeWindow(2, buildBox)];
    const worse: SystemMemoryPressurePayload = {
      ...BUILD_BOX_EPISODE,
      swapUsedPercent: 95,
      escalated: true,
    };
    const studioRecovered: SystemMemoryPressurePayload = { ...NORMAL, host: STUDIO };

    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, windows);
    publishHostSystemMemoryPressure(BUILD_BOX.id, BUILD_BOX_EPISODE, windows);
    publishHostSystemMemoryPressure(STUDIO.id, studioRecovered, windows);
    publishHostSystemMemoryPressure(BUILD_BOX.id, worse, windows);

    expect(studio.send.mock.calls).toEqual([pushed(STUDIO_EPISODE), pushed(studioRecovered)]);
    expect(buildBox.send.mock.calls).toEqual([pushed(BUILD_BOX_EPISODE), pushed(worse)]);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("raises a host's episode once in each window on it, then on a load or a reveal", () => {
    const visible = remoteView(STUDIO.id);
    const other = remoteView(STUDIO.id);
    const cached = remoteView(STUDIO.id);
    cachedWebContents.push(cached.wc);
    const win = makeWindow(1, visible);
    const otherWin = makeWindow(2, other);

    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, [win, otherWin]);
    expect(visible.send).toHaveBeenCalledTimes(1);
    expect(other.send).toHaveBeenCalledTimes(1);
    expect(cached.send).not.toHaveBeenCalled();

    // The host repeats its standing state to each view it attaches, decoded afresh each time.
    publishHostSystemMemoryPressure(STUDIO.id, structuredClone(STUDIO_EPISODE), [win, otherWin]);
    expect(visible.send).toHaveBeenCalledTimes(1);

    appWebContentsByWindow.set(1, cached.wc);
    deliverOpenSystemMemoryPressure(win, cached.wc);
    expect(cached.send.mock.calls).toEqual([pushed(STUDIO_EPISODE)]);

    appWebContentsByWindow.set(1, visible.wc);
    visible.startLoading();
    visible.setLoading(false);
    deliverOpenSystemMemoryPressure(win, visible.wc);
    expect(visible.send.mock.calls).toEqual([pushed(STUDIO_EPISODE), pushed(STUDIO_EPISODE)]);
  });

  it("announces a new episode whose readings repeat the last one's", () => {
    const view = remoteView(STUDIO.id);
    const win = makeWindow(1, view);
    const first = { ...STUDIO_EPISODE, episodeId: "ep-1" };
    const second = { ...STUDIO_EPISODE, episodeId: "ep-2" };

    publishHostSystemMemoryPressure(STUDIO.id, first, [win]);
    // Its recovery and a new opening were both lost with the link.
    publishHostSystemMemoryPressure(STUDIO.id, second, [win]);

    expect(view.send.mock.calls).toEqual([pushed(first), pushed(second)]);
  });

  it("takes down a host's notice quietly, in every view that may still show it", () => {
    const first = remoteView(STUDIO.id);
    const second = remoteView(STUDIO.id);
    const neverShown = remoteView(STUDIO.id);
    cachedWebContents.push(neverShown.wc);
    const win = makeWindow(1, first);
    const worse: SystemMemoryPressurePayload = {
      ...STUDIO_EPISODE,
      swapUsedPercent: 90,
      escalated: true,
    };
    const standing: SystemMemoryPressurePayload = { ...NORMAL, replay: true, host: STUDIO };

    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, [win]);
    // The window moves to another of the host's projects, which alone hears the escalation.
    cachedWebContents.push(first.wc);
    appWebContentsByWindow.set(1, second.wc);
    publishHostSystemMemoryPressure(STUDIO.id, worse, [win]);
    publishHostSystemMemoryPressure(STUDIO.id, standing, [win]);
    publishHostSystemMemoryPressure(STUDIO.id, standing, [win]);

    expect(first.send.mock.calls).toEqual([pushed(STUDIO_EPISODE), pushed(standing)]);
    expect(second.send.mock.calls).toEqual([pushed(worse), pushed(standing)]);
    expect(neverShown.send).not.toHaveBeenCalled();
    deliverOpenSystemMemoryPressure(win, first.wc);
    expect(first.send).toHaveBeenCalledTimes(2);
  });

  it("tells every view of a host, shown or not, of its measured recovery", () => {
    const visible = remoteView(STUDIO.id);
    const cached = remoteView(STUDIO.id);
    const elsewhere = remoteView(BUILD_BOX.id);
    cachedWebContents.push(cached.wc, elsewhere.wc);
    const win = makeWindow(1, visible);
    const recovered: SystemMemoryPressurePayload = { ...NORMAL, host: STUDIO };

    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, [win]);
    publishHostSystemMemoryPressure(STUDIO.id, recovered, [win]);

    expect(visible.send.mock.calls).toEqual([pushed(STUDIO_EPISODE), pushed(recovered)]);
    expect(cached.send.mock.calls).toEqual([pushed(recovered)]);
    expect(elsewhere.send).not.toHaveBeenCalled();
  });

  it("follows a view with no project to the machine its window moves to", () => {
    const picker = makeWebContents();
    const win = makeWindow(1, picker);

    publishSystemMemoryPressure(DEGRADED, [win]);
    routes.set(picker.wc.id, STUDIO.id);
    deliverOpenSystemMemoryPressure(win, picker.wc);
    publishHostSystemMemoryPressure(BUILD_BOX.id, BUILD_BOX_EPISODE, []);
    routes.set(picker.wc.id, BUILD_BOX.id);
    deliverOpenSystemMemoryPressure(win, picker.wc);

    expect(picker.send.mock.calls.map(([, envelope]) => envelope.payload)).toEqual([
      expect.objectContaining(DEGRADED),
      expect.objectContaining({ status: "normal", replay: true }),
      expect.objectContaining(BUILD_BOX_EPISODE),
    ]);
    // Back on this machine, it shows this machine's episode again.
    routes.delete(picker.wc.id);
    deliverOpenSystemMemoryPressure(win, picker.wc);
    expect(picker.send).toHaveBeenLastCalledWith(...pushed(DEGRADED));
  });

  it("leaves a view still loading to its own load when its window moves machines", () => {
    const view = makeWebContents();
    const win = makeWindow(1, view);
    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, []);
    routes.set(view.wc.id, STUDIO.id);

    view.startLoading();
    refreshSystemMemoryPressure(win, view.wc);
    expect(view.send).not.toHaveBeenCalled();

    deliverOpenSystemMemoryPressure(win, view.wc);
    expect(view.send.mock.calls).toEqual([pushed(STUDIO_EPISODE)]);
  });

  it("keeps a view's notice through a navigation that never commits", () => {
    const picker = makeWebContents();
    const win = makeWindow(1, picker);
    publishSystemMemoryPressure(DEGRADED, [win]);

    picker.commitSubframe();
    picker.startUncommittedNavigation();
    // The window moves to a host with no episode open while that navigation hangs.
    routes.set(picker.wc.id, STUDIO.id);
    refreshSystemMemoryPressure(win, picker.wc);
    refreshSystemMemoryPressure(win, picker.wc);
    expect(picker.send).toHaveBeenCalledTimes(1);
    picker.stopLoading();

    // The document that still shows this machine's notice is told quietly, once.
    expect(picker.send.mock.calls.map(([, envelope]) => envelope.payload)).toEqual([
      expect.objectContaining(DEGRADED),
      expect.objectContaining({ status: "normal", replay: true }),
    ]);
  });

  it("keeps every other host's episode when one recovers or is forgotten", () => {
    const studio = remoteView(STUDIO.id);
    const buildBox = remoteView(BUILD_BOX.id);
    const windows = [makeWindow(1, studio), makeWindow(2, buildBox)];
    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, windows);
    publishHostSystemMemoryPressure(BUILD_BOX.id, BUILD_BOX_EPISODE, windows);

    publishHostSystemMemoryPressure(STUDIO.id, { ...NORMAL, host: STUDIO }, windows);
    const lateBuildBox = remoteView(BUILD_BOX.id);
    deliverOpenSystemMemoryPressure(makeWindow(3, lateBuildBox), lateBuildBox.wc);
    forgetHostSystemMemoryPressure(STUDIO.id);
    const laterBuildBox = remoteView(BUILD_BOX.id);
    deliverOpenSystemMemoryPressure(makeWindow(4, laterBuildBox), laterBuildBox.wc);

    expect(lateBuildBox.send.mock.calls).toEqual([pushed(BUILD_BOX_EPISODE)]);
    expect(laterBuildBox.send.mock.calls).toEqual([pushed(BUILD_BOX_EPISODE)]);
  });

  it("lets a forgotten host's episode go quietly", () => {
    const studio = remoteView(STUDIO.id);
    const win = makeWindow(1, studio);
    publishHostSystemMemoryPressure(STUDIO.id, STUDIO_EPISODE, [win]);

    forgetHostSystemMemoryPressure(STUDIO.id);
    // A host re-pointed at another machine keeps its id: a load shows nothing of the old one.
    studio.startLoading();
    studio.setLoading(false);
    deliverOpenSystemMemoryPressure(win, studio.wc);

    expect(studio.send.mock.calls.map(([, envelope]) => envelope.payload)).toEqual([
      expect.objectContaining(STUDIO_EPISODE),
      expect.objectContaining({ status: "normal", replay: true }),
    ]);
  });

  it("tells the Shells attached here of each edge, under one id per episode", () => {
    const worse: SystemMemoryPressurePayload = {
      ...DEGRADED,
      swapUsedPercent: 97,
      escalated: true,
    };
    publishSystemMemoryPressure(DEGRADED, []);
    publishSystemMemoryPressure(worse, []);
    publishSystemMemoryPressure(NORMAL, []);
    publishSystemMemoryPressure(DEGRADED, []);

    const linked = vi.mocked(broadcastToRemoteEndpoints).mock.calls.map(([channel, args]) => {
      expect(channel).toBe(CHANNELS.EVENTS_PUSH);
      return (args[0] as { payload: SystemMemoryPressurePayload }).payload;
    });
    expect(linked).toEqual([
      { ...DEGRADED, episodeId: expect.any(String) },
      { ...worse, episodeId: linked[0]!.episodeId },
      { ...DEGRADED, episodeId: expect.any(String) },
    ]);
    expect(linked[2]!.episodeId).not.toBe(linked[0]!.episodeId);
    // Recovery reaches attached Shells with every other view.
    expect(broadcastToRenderer).toHaveBeenCalledWith(...pushed(NORMAL));
  });

  it("bounds the project names it sends a Shell", () => {
    const name = "n".repeat(5000);
    publishSystemMemoryPressure(
      {
        ...DEGRADED,
        workloads: {
          appMemoryMb: 100,
          projects: [{ projectId: "p", projectName: name, terminalCount: 1, memoryMb: 10 }],
          agentsRunning: 1,
          memoryTotalMb: 1024,
        },
      },
      []
    );

    const linked = vi.mocked(broadcastToRemoteEndpoints).mock.calls[0]![1][0] as {
      payload: SystemMemoryPressurePayload;
    };
    const sent = linked.payload.workloads!.projects[0]!.projectName!;
    expect(sent.length).toBeLessThan(name.length);
    expect(name.startsWith(sent.slice(0, -1))).toBe(true);
  });

  it("brings a view a Shell attaches up to date, quietly when no episode is open", () => {
    const send = vi.fn();
    const endpoint = {
      kind: "remote-view",
      isClosed: () => false,
      send,
    } as unknown as ClientEndpoint;

    replaySystemMemoryPressureToEndpoint(endpoint);
    publishSystemMemoryPressure(DEGRADED, []);
    replaySystemMemoryPressureToEndpoint(endpoint);

    expect(send.mock.calls).toEqual([
      [
        {
          type: "event",
          channel: CHANNELS.EVENTS_PUSH,
          args: [
            {
              name: "system:memory-pressure",
              payload: expect.objectContaining({ status: "normal", replay: true }),
            },
          ],
        },
      ],
      [
        {
          type: "event",
          channel: CHANNELS.EVENTS_PUSH,
          args: [
            {
              name: "system:memory-pressure",
              payload: { ...DEGRADED, episodeId: expect.any(String) },
            },
          ],
        },
      ],
    ]);
  });
});
