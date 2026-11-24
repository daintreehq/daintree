import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const undoItem = vi.hoisted(() => ({ label: "Undo" }));
const menuState = vi.hoisted(() => ({ installed: true }));
const focus = vi.hoisted(() => ({ current: null as unknown }));
const appListeners = vi.hoisted(() => new Map<string, Set<() => void>>());

vi.mock("electron", () => ({
  Menu: {
    getApplicationMenu: () =>
      menuState.installed
        ? { getMenuItemById: (id: string) => (id === "edit-undo" ? undoItem : null) }
        : null,
  },
  webContents: { getFocusedWebContents: () => focus.current },
  app: {
    on: (event: string, listener: () => void) => {
      const set = appListeners.get(event) ?? new Set();
      set.add(listener);
      appListeners.set(event, set);
    },
    removeListener: (event: string, listener: () => void) => {
      appListeners.get(event)?.delete(listener);
    },
  },
}));

import {
  currentUndoMenuLabel,
  formatUndoMenuLabel,
  handleUndoMenuClick,
  resetUndoMenuStateForTests,
  setUndoCloseState,
} from "../undoMenuState.js";
import { CHANNELS } from "../ipc/channels.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function fakeContents(id: number) {
  const listeners = new Map<string, Set<() => void>>();
  const add = (event: string, listener: () => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
  };
  const contents = {
    id,
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    on: vi.fn(add),
    once: vi.fn(add),
    removeListener: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    }),
    send: vi.fn(),
    undo: vi.fn(),
    emit(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
  };
  return contents;
}

type FakeContents = ReturnType<typeof fakeContents>;

function asContents(contents: FakeContents): Electron.WebContents {
  return contents as unknown as Electron.WebContents;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const click = { triggeredByAccelerator: false, metaKey: false };

describe("undoMenuState", () => {
  beforeEach(() => {
    resetUndoMenuStateForTests();
    undoItem.label = "Undo";
    menuState.installed = true;
    focus.current = null;
    appListeners.clear();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  describe("formatUndoMenuLabel", () => {
    it("names one panel by its title and a batch by its count", () => {
      expect(formatUndoMenuLabel(null)).toBe("Undo");
      expect(formatUndoMenuLabel({ count: 1, title: "Claude: fix tests" })).toBe(
        'Undo Close "Claude: fix tests"'
      );
      expect(formatUndoMenuLabel({ count: 3, title: null })).toBe("Undo Close 3 Panels");
    });

    it("falls back to the noun for a panel with no title", () => {
      expect(formatUndoMenuLabel({ count: 1, title: "  \n " })).toBe("Undo Close Panel");
      expect(formatUndoMenuLabel({ count: 1, title: null })).toBe("Undo Close Panel");
    });

    it("keeps a title's ampersands from becoming mnemonics", () => {
      expect(formatUndoMenuLabel({ count: 1, title: "R&D notes" })).toBe('Undo Close "R&&D notes"');
    });

    it("puts a title on one line and cuts a long one short", () => {
      const label = formatUndoMenuLabel({
        count: 1,
        title: `Claude:\n  ${"refactor the worktree dashboard ".repeat(4)}`,
      });
      const title = label.slice('Undo Close "'.length, -1);
      expect(title.startsWith("Claude: refactor the worktree")).toBe(true);
      expect(title.endsWith("…")).toBe(true);
      expect(Array.from(title).length).toBeLessThan(50);
      expect(title).not.toMatch(/\s{2}|\n/);
    });
  });

  describe("the label", () => {
    it("shows the focused view's close and nobody else's", async () => {
      const shown = fakeContents(1);
      const other = fakeContents(2);
      focus.current = shown;

      setUndoCloseState(asContents(other), { count: 2, title: null });
      await settle();
      expect(undoItem.label).toBe("Undo");

      setUndoCloseState(asContents(shown), { count: 1, title: "Shell" });
      await settle();
      expect(undoItem.label).toBe('Undo Close "Shell"');
    });

    it("follows focus between views and into a guest or DevTools", async () => {
      const first = fakeContents(1);
      const second = fakeContents(2);
      const devTools = fakeContents(3);
      focus.current = first;
      setUndoCloseState(asContents(first), { count: 1, title: "One" });
      setUndoCloseState(asContents(second), { count: 2, title: null });
      await settle();
      expect(undoItem.label).toBe('Undo Close "One"');

      focus.current = second;
      first.emit("blur");
      second.emit("focus");
      await settle();
      expect(undoItem.label).toBe("Undo Close 2 Panels");

      focus.current = devTools;
      second.emit("blur");
      await settle();
      expect(undoItem.label).toBe("Undo");

      focus.current = null;
      for (const listener of appListeners.get("browser-window-blur") ?? []) listener();
      await settle();
      expect(undoItem.label).toBe("Undo");

      focus.current = first;
      for (const listener of appListeners.get("browser-window-focus") ?? []) listener();
      await settle();
      expect(undoItem.label).toBe('Undo Close "One"');
    });

    it("goes back to Undo when the view clears its state or goes away", async () => {
      const view = fakeContents(1);
      focus.current = view;
      setUndoCloseState(asContents(view), { count: 1, title: "One" });
      await settle();
      expect(undoItem.label).toBe('Undo Close "One"');

      setUndoCloseState(asContents(view), null);
      await settle();
      expect(undoItem.label).toBe("Undo");

      setUndoCloseState(asContents(view), { count: 1, title: "One" });
      await settle();
      view.destroyed = true;
      view.emit("destroyed");
      await settle();
      expect(currentUndoMenuLabel()).toBe("Undo");
      expect(undoItem.label).toBe("Undo");
    });

    it("forgets a view's close when its renderer dies", async () => {
      const view = fakeContents(1);
      const other = fakeContents(2);
      focus.current = view;
      setUndoCloseState(asContents(view), { count: 1, title: "One" });
      setUndoCloseState(asContents(other), { count: 1, title: "Two" });
      await settle();
      expect(undoItem.label).toBe('Undo Close "One"');

      // A crash loop's recovery page keeps the WebContents but never publishes.
      for (const listener of appListeners.get("render-process-gone") ?? []) {
        (listener as unknown as (event: unknown, wc: unknown) => void)({}, view);
      }
      await settle();
      expect(undoItem.label).toBe("Undo");
      handleUndoMenuClick(click);
      expect(view.send).not.toHaveBeenCalled();
      expect(view.undo).toHaveBeenCalledTimes(1);

      focus.current = other;
      expect(currentUndoMenuLabel()).toBe('Undo Close "Two"');
    });

    it("listens for focus only once a view names a close", () => {
      const view = fakeContents(1);
      setUndoCloseState(asContents(view), null);
      expect(view.on).not.toHaveBeenCalled();
      expect(appListeners.size).toBe(0);

      setUndoCloseState(asContents(view), { count: 1, title: "One" });
      setUndoCloseState(asContents(view), { count: 2, title: null });
      expect(view.on.mock.calls.map(([event]) => event).sort()).toEqual(["blur", "focus"]);
      expect(appListeners.get("browser-window-focus")?.size).toBe(1);
    });

    it("does nothing without an installed menu", async () => {
      menuState.installed = false;
      const view = fakeContents(1);
      focus.current = view;
      setUndoCloseState(asContents(view), { count: 1, title: "One" });
      await settle();
      expect(undoItem.label).toBe("Undo");
    });
  });

  describe("choosing Edit > Undo", () => {
    it("reopens the close the focused view names", () => {
      const view = fakeContents(1);
      focus.current = view;
      setUndoCloseState(asContents(view), { count: 1, title: "One" });

      handleUndoMenuClick(click);

      expect(view.send).toHaveBeenCalledWith(CHANNELS.MENU_ACTION, {
        actionId: "panel.undoClose",
      });
      expect(view.undo).not.toHaveBeenCalled();
    });

    it("undoes text where nothing is named", () => {
      const view = fakeContents(1);
      const named = fakeContents(2);
      setUndoCloseState(asContents(named), { count: 1, title: "One" });
      focus.current = view;

      handleUndoMenuClick(click);

      expect(view.undo).toHaveBeenCalledTimes(1);
      expect(view.send).not.toHaveBeenCalled();
      expect(named.send).not.toHaveBeenCalled();
    });

    it("undoes text for Cmd+Z on the Mac, which reaches the menu only when the view let it go", () => {
      setPlatform("darwin");
      const view = fakeContents(1);
      focus.current = view;
      setUndoCloseState(asContents(view), { count: 1, title: "One" });

      handleUndoMenuClick({ triggeredByAccelerator: true, metaKey: true });
      expect(view.undo).toHaveBeenCalledTimes(1);
      expect(view.send).not.toHaveBeenCalled();

      // Picked from the keyboard-navigated menu: a choice, not the key.
      handleUndoMenuClick({ triggeredByAccelerator: true, metaKey: false });
      expect(view.send).toHaveBeenCalledTimes(1);
    });

    it("reopens from a keyboard-navigated menu off the Mac, where the item carries no key", () => {
      setPlatform("win32");
      const view = fakeContents(1);
      focus.current = view;
      setUndoCloseState(asContents(view), { count: 1, title: "One" });

      handleUndoMenuClick({ triggeredByAccelerator: true, metaKey: false });

      expect(view.send).toHaveBeenCalledTimes(1);
      expect(view.undo).not.toHaveBeenCalled();
    });

    it("does nothing with nothing focused", () => {
      expect(() => handleUndoMenuClick(click)).not.toThrow();
    });
  });
});
