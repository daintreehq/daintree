import { describe, it, expect, vi, beforeEach } from "vitest";

const getAppWebContentsMock = vi.hoisted(() => vi.fn());
vi.mock("../webContentsRegistry.js", () => ({
  getAppWebContents: getAppWebContentsMock,
}));

import { CHANNELS } from "../../ipc/channels.js";
import {
  claimProjectActivation,
  findOtherProjectOwner,
  hasLiveProjectView,
  redirectNewWindowToOwner,
  redirectToProjectOwner,
  revealWindow,
} from "../projectOwnership.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";
import type { Project } from "../../../shared/types/project.js";

function makeWebContents(destroyed = false, loading = false) {
  return {
    isDestroyed: () => destroyed,
    isLoadingMainFrame: vi.fn(() => loading),
    once: vi.fn(),
    focus: vi.fn(),
    send: vi.fn(),
  };
}

function makePvm(active: string | null, views: Array<string | [string, { destroyed: boolean }]>) {
  const entries = views.map((v) => {
    const [projectId, opts] = typeof v === "string" ? [v, { destroyed: false }] : v;
    return { projectId, view: { webContents: makeWebContents(opts.destroyed) } };
  });
  return {
    getActiveProjectId: vi.fn(() => active),
    getOutgoingBridgeProjectId: vi.fn<() => string | null>(() => null),
    getAllViews: vi.fn(() => entries),
    getActiveView: vi.fn(() => entries.find((e) => e.projectId === active)?.view ?? null),
    setPendingFocusIntent: vi.fn(),
  };
}

function makeBrowserWindow(opts: { minimized?: boolean; destroyed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

function makeContext(
  windowId: number,
  pvm: ReturnType<typeof makePvm> | undefined,
  browserWindow = makeBrowserWindow()
): WindowContext {
  return {
    windowId,
    browserWindow,
    services: { projectViewManager: pvm },
  } as unknown as WindowContext;
}

function registryOf(contexts: WindowContext[]): WindowRegistry {
  return { all: () => contexts } as unknown as WindowRegistry;
}

const PROJECT = { id: "p", name: "P", path: "/p" } as Project;

describe("hasLiveProjectView", () => {
  it("counts a cached view as live", () => {
    expect(hasLiveProjectView(makePvm("q", ["q", "p"]) as never, "p")).toBe(true);
  });

  it("ignores a view whose renderer is already destroyed", () => {
    expect(hasLiveProjectView(makePvm("q", ["q", ["p", { destroyed: true }]]) as never, "p")).toBe(
      false
    );
  });

  it("answers false for a missing or throwing manager", () => {
    expect(hasLiveProjectView(undefined, "p")).toBe(false);
    const throwing = makePvm("p", ["p"]);
    throwing.getAllViews.mockImplementation(() => {
      throw new Error("disposed");
    });
    expect(hasLiveProjectView(throwing as never, "p")).toBe(false);
  });
});

describe("findOtherProjectOwner", () => {
  it("prefers the window showing the project over one that only has it cached", () => {
    const cached = makeContext(2, makePvm("q", ["q", "p"]));
    const shown = makeContext(3, makePvm("p", ["p"]));

    const owner = findOtherProjectOwner(registryOf([cached, shown]), "p", { windowId: 1 });

    expect(owner?.context).toBe(shown);
    expect(owner?.state).toBe("foreground");
  });

  it("falls back to a window that has the project cached", () => {
    const cached = makeContext(2, makePvm("q", ["q", "p"]));

    const owner = findOtherProjectOwner(registryOf([cached]), "p", { windowId: 1 });

    expect(owner?.context).toBe(cached);
    expect(owner?.state).toBe("cached");
  });

  it("never names the requesting window, by id or by the manager it acts on", () => {
    const pvm = makePvm("p", ["p"]);
    const requester = makeContext(1, pvm);
    // The switch handler can fall back to a manager that belongs to a window
    // other than the sender's; that manager is the one the request acts on.
    const sameManagerElsewhere = makeContext(2, pvm);

    expect(
      findOtherProjectOwner(registryOf([requester, sameManagerElsewhere]), "p", {
        windowId: 1,
        projectViewManager: pvm as unknown as ProjectViewManager,
      })
    ).toBeNull();
  });

  it("skips destroyed windows and windows with no manager", () => {
    const destroyed = makeContext(2, makePvm("p", ["p"]), makeBrowserWindow({ destroyed: true }));
    const bare = makeContext(3, undefined);

    expect(findOtherProjectOwner(registryOf([destroyed, bare]), "p", { windowId: 1 })).toBeNull();
  });

  it("answers null without a registry", () => {
    expect(findOtherProjectOwner(undefined, "p", { windowId: 1 })).toBeNull();
  });
});

describe("claimProjectActivation", () => {
  it("makes a window that is still activating the project its owner", () => {
    const activating = makeContext(2, makePvm("q", ["q"]));
    const release = claimProjectActivation("p", 2);
    try {
      const owner = findOtherProjectOwner(registryOf([activating]), "p", { windowId: 1 });
      expect(owner?.context).toBe(activating);
      expect(owner?.state).toBe("activating");
    } finally {
      release();
    }
    expect(findOtherProjectOwner(registryOf([activating]), "p", { windowId: 1 })).toBeNull();
  });

  it("never makes the claiming window its own owner", () => {
    const activating = makeContext(2, makePvm("q", ["q"]));
    const release = claimProjectActivation("p", 2);
    try {
      expect(findOtherProjectOwner(registryOf([activating]), "p", { windowId: 2 })).toBeNull();
    } finally {
      release();
    }
  });

  it("defers to the manager once it holds the view, even while the claim is live", () => {
    // Activated, then switched on before its handler settled: cached, not shown.
    const switchedOn = makeContext(2, makePvm("q", ["q", "p"]));
    const release = claimProjectActivation("p", 2);
    try {
      const owner = findOtherProjectOwner(registryOf([switchedOn]), "p", { windowId: 1 });
      expect(owner?.state).toBe("cached");
    } finally {
      release();
    }
  });

  it("keeps a window's claim while another of its activations is still in flight", () => {
    // A menu open landing on an IPC switch of the same project: whichever
    // settles first must not drop the protection the other still needs.
    const activating = makeContext(2, makePvm("q", ["q"]));
    const releaseFirst = claimProjectActivation("p", 2);
    const releaseSecond = claimProjectActivation("p", 2);
    releaseSecond();
    try {
      const owner = findOtherProjectOwner(registryOf([activating]), "p", { windowId: 1 });
      expect(owner?.state).toBe("activating");
    } finally {
      releaseFirst();
    }
    expect(findOtherProjectOwner(registryOf([activating]), "p", { windowId: 1 })).toBeNull();
  });

  it("treats a second release of the same claim as a no-op", () => {
    const activating = makeContext(2, makePvm("q", ["q"]));
    const release = claimProjectActivation("p", 2);
    const other = claimProjectActivation("p", 2);
    release();
    release();
    try {
      expect(findOtherProjectOwner(registryOf([activating]), "p", { windowId: 1 })).not.toBeNull();
    } finally {
      other();
    }
  });
});

describe("redirectNewWindowToOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("brings forward the window that has the project, instead of opening another", async () => {
    const win = makeBrowserWindow();
    const registry = registryOf([makeContext(2, makePvm("p", ["p"]), win)]);

    const redirected = await redirectNewWindowToOwner(registry, "/p", async () => PROJECT);

    expect(redirected).toBe(true);
    expect(win.focus).toHaveBeenCalled();
  });

  it("opens a window as before for a folder no window has", async () => {
    const registry = registryOf([makeContext(2, makePvm("q", ["q"]))]);
    expect(await redirectNewWindowToOwner(registry, "/p", async () => PROJECT)).toBe(false);
  });

  it("opens a window as before for a folder that isn't a project yet", async () => {
    const registry = registryOf([makeContext(2, makePvm("p", ["p"]))]);
    expect(await redirectNewWindowToOwner(registry, "/new", async () => null)).toBe(false);
  });

  it("opens a window as before when the lookup fails", async () => {
    const registry = registryOf([makeContext(2, makePvm("p", ["p"]))]);
    const failing = async () => {
      throw new Error("db closed");
    };
    expect(await redirectNewWindowToOwner(registry, "/p", failing)).toBe(false);
  });
});

describe("revealWindow", () => {
  it("restores a minimized window before showing and focusing it", () => {
    const win = makeBrowserWindow({ minimized: true });
    revealWindow(win as never);
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it("does nothing to a destroyed window", () => {
    const win = makeBrowserWindow({ destroyed: true });
    revealWindow(win as never);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });
});

describe("redirectToProjectOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("focuses the owning view when the project is on screen there", () => {
    const pvm = makePvm("p", ["p"]);
    const win = makeBrowserWindow();
    const owner = {
      context: makeContext(2, pvm, win),
      projectViewManager: pvm,
      state: "foreground",
    };

    const result = redirectToProjectOwner(owner as never, PROJECT, {
      intent: "focus-next-waiting",
    });

    expect(result).toEqual({ outcome: "focused-elsewhere", project: PROJECT, targetWindowId: 2 });
    const webContents = pvm.getActiveView()!.webContents;
    expect(win.focus).toHaveBeenCalled();
    expect(webContents.focus).toHaveBeenCalled();
    expect(webContents.send).toHaveBeenCalledWith(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, {
      intent: "focus-next-waiting",
    });
    expect(getAppWebContentsMock).not.toHaveBeenCalled();
  });

  it("asks the owning renderer to switch when the project is only cached there", () => {
    const pvm = makePvm("q", ["q", "p"]);
    const win = makeBrowserWindow();
    const appWebContents = makeWebContents();
    getAppWebContentsMock.mockReturnValue(appWebContents);
    const owner = {
      context: makeContext(2, pvm, win),
      projectViewManager: pvm,
      state: "cached",
    };
    const focusIntent = { intent: "focus-panel", panelId: "x" } as const;

    const result = redirectToProjectOwner(owner as never, PROJECT, focusIntent);

    expect(result).toEqual({ outcome: "activated-elsewhere", project: PROJECT, targetWindowId: 2 });
    expect(pvm.setPendingFocusIntent).toHaveBeenCalledWith("p", focusIntent);
    expect(appWebContents.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, {
      actionId: "project.switch",
      args: { projectId: "p" },
    });
    expect(win.focus).toHaveBeenCalled();
  });

  it("waits for a still-loading owner view before asking it to switch", () => {
    const pvm = makePvm("r", ["q", "p"]);
    const appWebContents = makeWebContents(false, true);
    getAppWebContentsMock.mockReturnValue(appWebContents);
    const owner = { context: makeContext(2, pvm), projectViewManager: pvm, state: "cached" };

    redirectToProjectOwner(owner as never, PROJECT);

    expect(appWebContents.send).not.toHaveBeenCalled();
    expect(appWebContents.once).toHaveBeenCalledWith("did-finish-load", expect.any(Function));
    const onLoaded = appWebContents.once.mock.calls[0]![1] as () => void;
    onLoaded();
    expect(appWebContents.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, {
      actionId: "project.switch",
      args: { projectId: "p" },
    });
  });

  it("hands the switch to the outgoing view while the owner is mid cold switch", () => {
    // The app view is already the incoming project's fresh renderer, which has
    // no listener yet and may fail to load; the outgoing one is still booted.
    const pvm = makePvm("r", ["o", "p", "r"]);
    pvm.getOutgoingBridgeProjectId.mockReturnValue("o");
    const appWebContents = makeWebContents(false, true);
    getAppWebContentsMock.mockReturnValue(appWebContents);
    const owner = { context: makeContext(2, pvm), projectViewManager: pvm, state: "cached" };

    redirectToProjectOwner(owner as never, PROJECT);

    const outgoing = pvm.getAllViews().find((e) => e.projectId === "o")!.view.webContents;
    expect(outgoing.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, {
      actionId: "project.switch",
      args: { projectId: "p" },
    });
    expect(appWebContents.send).not.toHaveBeenCalled();
    expect(appWebContents.once).not.toHaveBeenCalled();
  });

  it("parks the intent for a window whose cold switch to the project hasn't landed", () => {
    // `activeProjectId` flips before the incoming view can listen, so a send
    // now would be dropped; the switch in flight delivers what is parked.
    const pvm = makePvm("p", ["o", "p"]);
    pvm.getOutgoingBridgeProjectId.mockReturnValue("o");
    const owner = { context: makeContext(2, pvm), projectViewManager: pvm, state: "foreground" };
    const focusIntent = { intent: "focus-next-waiting" } as const;

    redirectToProjectOwner(owner as never, PROJECT, focusIntent);

    expect(pvm.getActiveView()!.webContents.send).not.toHaveBeenCalled();
    expect(pvm.setPendingFocusIntent).toHaveBeenCalledWith("p", focusIntent);
  });

  it("only brings forward a window still activating the project, parking the intent", () => {
    // Its active view is still the project it is leaving: focusing it, or
    // sending it the intent, would land on the wrong project.
    const pvm = makePvm("q", ["q"]);
    const win = makeBrowserWindow();
    const owner = {
      context: makeContext(2, pvm, win),
      projectViewManager: pvm,
      state: "activating",
    };
    const focusIntent = { intent: "focus-next-waiting" } as const;

    const result = redirectToProjectOwner(owner as never, PROJECT, focusIntent);

    expect(result).toEqual({ outcome: "focused-elsewhere", project: PROJECT, targetWindowId: 2 });
    expect(win.focus).toHaveBeenCalled();
    const leavingView = pvm.getActiveView()!.webContents;
    expect(leavingView.focus).not.toHaveBeenCalled();
    expect(leavingView.send).not.toHaveBeenCalled();
    expect(pvm.setPendingFocusIntent).toHaveBeenCalledWith("p", focusIntent);
    expect(getAppWebContentsMock).not.toHaveBeenCalled();
  });
});
