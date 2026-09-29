import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const all: FakeWindow[] = [];
  class FakeWindow {
    static getFocusedWindow: () => FakeWindow | null = () => null;
    static getAllWindows = () => all.filter((w) => !w.destroyed);
    static fromWebContents = (contents: FakeContents) => contents.owner;
    visible = false;
    minimized = false;
    destroyed = false;
    opacity = 1;
    ignoreMouse = false;
    events: string[] = [];
    listeners = new Map<string, Array<() => void>>();
    nativeShowInactive = vi.fn();
    emit(event: string): boolean {
      this.events.push(event);
      for (const fn of this.listeners.get(event) ?? []) fn();
      return true;
    }
    once(event: string, fn: () => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
      return this;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    setOpacity(value: number): void {
      this.opacity = value;
    }
    setIgnoreMouseEvents(value: boolean): void {
      this.ignoreMouse = value;
    }
    close(): void {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  class FakeContents {
    owner: FakeWindow | null = null;
    nativeFocus = vi.fn();
    focus(): void {
      this.nativeFocus();
    }
  }
  const nativeMethods = {
    show: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    isFocused: vi.fn(() => false),
    showInactive(this: FakeWindow) {
      this.nativeShowInactive();
      this.visible = true;
    },
    hide(this: FakeWindow) {
      this.visible = false;
    },
    minimize(this: FakeWindow) {
      this.minimized = true;
    },
    restore(this: FakeWindow) {
      this.minimized = false;
    },
    isVisible(this: FakeWindow) {
      return this.visible;
    },
  };
  const appListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const nativeAppFocus = vi.fn();
  const app = {
    commandLine: { appendSwitch: vi.fn() },
    setActivationPolicy: vi.fn(),
    focus: nativeAppFocus as () => void,
    on(event: string, fn: (...args: unknown[]) => void) {
      appListeners.set(event, [...(appListeners.get(event) ?? []), fn]);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of appListeners.get(event) ?? []) fn(...args);
    },
  };
  const reset = () => {
    all.length = 0;
    appListeners.clear();
    Object.assign(FakeWindow.prototype, nativeMethods);
    FakeWindow.getFocusedWindow = () => null;
    app.focus = nativeAppFocus;
  };
  return { BrowserWindow: FakeWindow, FakeContents, app, nativeAppFocus, all, reset };
});

vi.mock("electron", () => ({ BrowserWindow: electronMock.BrowserWindow, app: electronMock.app }));

type Win = InstanceType<typeof electronMock.BrowserWindow> & {
  show(): void;
  focus(): void;
  blur(): void;
  hide(): void;
  minimize(): void;
  restore(): void;
  isFocused(): boolean;
};

function createWindow(): Win {
  const win = new electronMock.BrowserWindow() as Win;
  electronMock.all.push(win);
  electronMock.app.emit("browser-window-created", {}, win);
  return win;
}

function createContents(owner: Win | null): InstanceType<typeof electronMock.FakeContents> {
  const contents = new electronMock.FakeContents();
  contents.owner = owner;
  electronMock.app.emit("web-contents-created", {}, contents);
  return contents;
}

const focusedWindow = () => electronMock.BrowserWindow.getFocusedWindow();

describe("installE2EBackgroundWindows", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    electronMock.reset();
    const { installE2EBackgroundWindows } = await import("../e2eBackgroundWindows.js");
    installE2EBackgroundWindows();
  });

  afterEach(() => {
    electronMock.reset();
  });

  it("makes new windows transparent and click-through", () => {
    const win = createWindow();
    expect(win.opacity).toBe(0);
    expect(win.ignoreMouse).toBe(true);
  });

  it("keeps the app from ever activating", () => {
    expect(electronMock.app.setActivationPolicy).toHaveBeenCalledWith("prohibited");
    expect(electronMock.app.commandLine.appendSwitch).toHaveBeenCalledWith(
      "disable-backgrounding-occluded-windows"
    );
    electronMock.app.focus();
    expect(electronMock.nativeAppFocus).not.toHaveBeenCalled();
  });

  it("reveals inactively on show() and records virtual focus", () => {
    const win = createWindow();
    win.show();
    expect(win.nativeShowInactive).toHaveBeenCalledTimes(1);
    expect(win.visible).toBe(true);
    expect(win.isFocused()).toBe(true);
    expect(focusedWindow()).toBe(win);
    expect(win.events).toEqual(["focus"]);
  });

  it("leaves a hidden window hidden and unfocused on focus(), as native focus does", () => {
    const win = createWindow();
    win.focus();
    expect(win.visible).toBe(false);
    expect(win.isFocused()).toBe(false);
    expect(win.events).toEqual([]);
  });

  it("moves focus between windows with blur/focus events", () => {
    const a = createWindow();
    const b = createWindow();
    a.show();
    b.show();
    a.focus();
    expect(focusedWindow()).toBe(a);
    expect(b.isFocused()).toBe(false);
    expect(a.events).toEqual(["focus", "blur", "focus"]);
    expect(b.events).toEqual(["focus", "blur"]);
    a.focus();
    expect(a.events).toEqual(["focus", "blur", "focus"]);
  });

  it("clears focus on blur() without handing it on", () => {
    const a = createWindow();
    const b = createWindow();
    a.show();
    b.show();
    a.blur();
    expect(focusedWindow()).toBe(b);
    b.blur();
    expect(focusedWindow()).toBeNull();
    expect(b.events).toEqual(["focus", "blur"]);
  });

  it("hands focus to another visible window on hide() and minimize()", () => {
    const a = createWindow();
    const b = createWindow();
    a.show();
    b.show();
    b.hide();
    expect(b.visible).toBe(false);
    expect(focusedWindow()).toBe(a);
    expect(b.events).toEqual(["focus", "blur"]);
    a.minimize();
    expect(a.minimized).toBe(true);
    expect(focusedWindow()).toBeNull();
    expect(a.isFocused()).toBe(false);
  });

  it("refocuses a window on restore()", () => {
    const win = createWindow();
    win.show();
    win.minimize();
    expect(win.isFocused()).toBe(false);
    win.restore();
    expect(win.isFocused()).toBe(true);
    expect(win.events).toEqual(["focus", "blur", "focus"]);
  });

  it("hands focus to a surviving window when the focused one closes", () => {
    const a = createWindow();
    const b = createWindow();
    a.show();
    b.show();
    b.close();
    expect(b.isFocused()).toBe(false);
    expect(focusedWindow()).toBe(a);
    expect(a.events).toEqual(["focus", "blur", "focus"]);
  });

  it("drops focus when the last window closes, with no stale blur afterwards", () => {
    const a = createWindow();
    a.show();
    a.close();
    expect(a.isFocused()).toBe(false);
    const b = createWindow();
    b.show();
    expect(a.events).toEqual(["focus", "closed"]);
  });

  it("mirrors webContents.focus() into its owner window's focus", () => {
    const a = createWindow();
    const b = createWindow();
    a.show();
    b.show();
    const contents = createContents(a);
    contents.focus();
    expect(contents.nativeFocus).toHaveBeenCalledTimes(1);
    expect(focusedWindow()).toBe(a);
    const orphan = createContents(null);
    orphan.focus();
    expect(orphan.nativeFocus).toHaveBeenCalledTimes(1);
    expect(focusedWindow()).toBe(a);
  });
});
