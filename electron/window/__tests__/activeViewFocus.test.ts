import { EventEmitter } from "node:events";
import { describe, it, expect, vi, type Mock } from "vitest";
import type { BrowserWindow, WebContentsView } from "electron";
import { attachActiveViewFocus, focusActiveViewIfUnfocused } from "../activeViewFocus.js";

interface FakeWebContents {
  focused: boolean;
  destroyed: boolean;
  isFocused: () => boolean;
  isDestroyed: () => boolean;
  focus: Mock<() => void>;
}

interface FakeWindow extends EventEmitter {
  active: boolean;
  destroyed: boolean;
  shell: FakeWebContents;
  contentView: { children: Array<{ webContents?: FakeWebContents }> };
  isFocused: () => boolean;
  isDestroyed: () => boolean;
}

/** Keyboard focus is one place per window: focusing a webContents takes it from the rest. */
function createScene() {
  const all: FakeWebContents[] = [];
  const makeWc = (): FakeWebContents => {
    const wc: FakeWebContents = {
      focused: false,
      destroyed: false,
      isFocused: () => wc.focused,
      isDestroyed: () => wc.destroyed,
      focus: vi.fn(() => {
        for (const other of all) other.focused = false;
        wc.focused = true;
      }),
    };
    all.push(wc);
    return wc;
  };

  const makeView = () => ({ webContents: makeWc() });
  const shell = makeWc();
  const projectView = makeView();
  const portalView = makeView();
  const surfaceView = makeView();

  const win = Object.assign(new EventEmitter(), {
    active: false,
    destroyed: false,
    shell,
    contentView: {
      children: [projectView, portalView, surfaceView] as FakeWindow["contentView"]["children"],
    },
    isFocused: () => win.active && !win.destroyed,
    isDestroyed: () => win.destroyed,
  }) as FakeWindow;

  /**
   * What Electron does on Windows and Linux when the window activates: the
   * shell's own webContents takes focus, then the `focus` event fires.
   */
  const activate = (): void => {
    win.active = true;
    shell.focus();
    win.emit("focus");
  };
  const deactivate = (): void => {
    win.active = false;
    win.emit("blur");
  };

  return { win, shell, projectView, portalView, surfaceView, makeView, activate, deactivate };
}

const asWindow = (win: FakeWindow) => win as unknown as BrowserWindow;
const asView = (view: { webContents?: FakeWebContents }) => view as unknown as WebContentsView;
const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("attachActiveViewFocus", () => {
  it("moves focus out of the empty shell into the active view on the first activation", async () => {
    const { win, shell, projectView, activate } = createScene();
    attachActiveViewFocus(asWindow(win), { getActiveView: () => asView(projectView) });

    activate();
    expect(shell.isFocused()).toBe(true);
    expect(projectView.webContents.focus).not.toHaveBeenCalled();

    await flushImmediates();
    expect(projectView.webContents.isFocused()).toBe(true);
    expect(shell.isFocused()).toBe(false);
  });

  it("leaves focus with a browser panel that Chromium restored after the focus event", async () => {
    const { win, projectView, portalView, activate } = createScene();
    attachActiveViewFocus(asWindow(win), { getActiveView: () => asView(projectView) });

    activate();
    // Chromium hands the stored child focus back after the event has fired.
    portalView.webContents.focus();

    await flushImmediates();
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
    expect(portalView.webContents.isFocused()).toBe(true);
  });

  it("does not refocus a project view that already holds focus", async () => {
    const { win, projectView, activate } = createScene();
    attachActiveViewFocus(asWindow(win), { getActiveView: () => asView(projectView) });

    activate();
    projectView.webContents.focus();
    projectView.webContents.focus.mockClear();

    await flushImmediates();
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
  });

  it("never focuses a window revealed inactive, since focusing a view activates its window", async () => {
    const { win, projectView } = createScene();
    const handle = attachActiveViewFocus(asWindow(win), {
      getActiveView: () => asView(projectView),
    });

    handle.schedule();
    await flushImmediates();
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
  });

  it("drops a queued check when the window loses activation before it runs", async () => {
    const { win, projectView, activate, deactivate } = createScene();
    attachActiveViewFocus(asWindow(win), { getActiveView: () => asView(projectView) });

    activate();
    deactivate();
    // Active again without a new focus event, so only the cancel can stop it.
    win.active = true;

    await flushImmediates();
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
  });

  it("checks once per turn however many focus events arrive", async () => {
    const { win, shell, projectView, activate } = createScene();
    const handle = attachActiveViewFocus(asWindow(win), {
      getActiveView: () => asView(projectView),
    });

    activate();
    handle.schedule();
    win.emit("focus");

    await flushImmediates();
    expect(projectView.webContents.focus).toHaveBeenCalledTimes(1);
    expect(shell.isFocused()).toBe(false);
  });

  it("handles every later activation that comes back with focus in the shell", async () => {
    const { win, projectView, activate, deactivate } = createScene();
    attachActiveViewFocus(asWindow(win), { getActiveView: () => asView(projectView) });

    activate();
    await flushImmediates();
    deactivate();
    activate();
    await flushImmediates();

    expect(projectView.webContents.focus).toHaveBeenCalledTimes(2);
    expect(projectView.webContents.isFocused()).toBe(true);
  });

  it("focuses the view the window shows at activation, not the one it started with", async () => {
    const { win, projectView, makeView, activate } = createScene();
    const switchedTo = makeView();
    win.contentView.children.push(switchedTo);
    let current: { webContents?: FakeWebContents } = projectView;
    attachActiveViewFocus(asWindow(win), { getActiveView: () => asView(current) });
    current = switchedTo;

    activate();
    await flushImmediates();
    expect(switchedTo.webContents.isFocused()).toBe(true);
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
  });

  // The window's own "closed" handler disposes it: a listener of its own would be
  // the eleventh on the window and trip Node's leak warning.
  it("stops once disposed", async () => {
    const { win, projectView, activate } = createScene();
    const handle = attachActiveViewFocus(asWindow(win), {
      getActiveView: () => asView(projectView),
    });

    activate();
    handle.dispose();
    await flushImmediates();
    activate();
    await flushImmediates();

    expect(projectView.webContents.focus).not.toHaveBeenCalled();
    expect(win.listenerCount("focus")).toBe(0);
    expect(win.listenerCount("closed")).toBe(0);
  });
});

describe("focusActiveViewIfUnfocused", () => {
  it("defers to a switch that is still showing the outgoing view", () => {
    const { win, projectView } = createScene();
    win.active = true;

    const focused = focusActiveViewIfUnfocused(asWindow(win), {
      getActiveView: () => asView(projectView),
      isSwitchBridged: () => true,
    });

    expect(focused).toBe(false);
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
  });

  it("does nothing for a view that is not attached to the window", () => {
    const { win, makeView } = createScene();
    win.active = true;
    const detached = makeView();

    const focused = focusActiveViewIfUnfocused(asWindow(win), {
      getActiveView: () => asView(detached),
    });

    expect(focused).toBe(false);
    expect(detached.webContents.focus).not.toHaveBeenCalled();
  });

  it("does nothing when the active view's renderer is gone or there is no view", () => {
    const { win, projectView } = createScene();
    win.active = true;
    projectView.webContents.destroyed = true;

    expect(
      focusActiveViewIfUnfocused(asWindow(win), { getActiveView: () => asView(projectView) })
    ).toBe(false);
    expect(focusActiveViewIfUnfocused(asWindow(win), { getActiveView: () => null })).toBe(false);
    expect(projectView.webContents.focus).not.toHaveBeenCalled();
  });

  it("ignores destroyed and non-web children when looking for existing focus", () => {
    const { win, projectView, portalView } = createScene();
    win.active = true;
    portalView.webContents.focused = true;
    portalView.webContents.destroyed = true;
    win.contentView.children = [{}, projectView, portalView];

    const focused = focusActiveViewIfUnfocused(asWindow(win), {
      getActiveView: () => asView(projectView),
    });

    expect(focused).toBe(true);
    expect(projectView.webContents.focus).toHaveBeenCalledTimes(1);
  });
});
