// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewState = vi.hoisted(() => ({ observable: true }));
const runtime = vi.hoisted(() => ({ owners: new Map<string, string>() }));

vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => viewState.observable,
}));

vi.mock("@/services/plugin/pluginDocumentRuntime", () => ({
  pluginDocumentRuntime: {
    sourceForUrl: (url: string) => {
      const host = /^plugin:\/\/([^/]+)/.exec(url)?.[1];
      const pluginId = host ? runtime.owners.get(host) : undefined;
      return pluginId ? { pluginId, generation: null, url } : undefined;
    },
  },
}));

import { useUIStore } from "@/store/uiStore";
import {
  CAPTURE_CONSOLE_LIMIT,
  CAPTURE_CONSOLE_MAX_BYTES,
  PanelCaptureRefusedError,
  assertPanelCapturable,
  consoleMessagesForPlugin,
  locatePanelFrame,
  sameRect,
} from "../pluginPanelCapture";

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function appRoot(): HTMLElement {
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  return root;
}

function mountFrame(
  panelId: string,
  rect = box(100, 50, 400, 300),
  parent: HTMLElement = appRoot()
): HTMLElement {
  const frame = document.createElement("div");
  frame.dataset.panelId = panelId;
  frame.dataset.panelLocation = "grid";
  const inner = document.createElement("div");
  frame.appendChild(inner);
  frame.getBoundingClientRect = () => rect;
  parent.appendChild(frame);
  return frame;
}

/** A body-level portal, as `createPortal` mounts dialogs, toasts and menus. */
function portal(rect: DOMRect, attrs: Record<string, string> = {}): HTMLElement {
  const layer = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v);
  layer.getBoundingClientRect = () => rect;
  document.body.appendChild(layer);
  return layer;
}

let hitTarget: Element | null = null;

beforeEach(() => {
  viewState.observable = true;
  runtime.owners.clear();
  useUIStore.setState({ overlayStack: [] });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  hitTarget = null;
  document.elementFromPoint = vi.fn(() => hitTarget);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("locatePanelFrame", () => {
  it("finds the panel's frame, not other elements carrying its id", () => {
    const tab = document.createElement("button");
    tab.dataset.panelId = "p1";
    document.body.appendChild(tab);
    const frame = mountFrame("p1");

    expect(locatePanelFrame("p1")).toBe(frame);
  });

  it("refuses a panel with no frame, or with two mid-move", () => {
    expect(() => locatePanelFrame("p1")).toThrow(/isn't on screen/);
    mountFrame("p1");
    mountFrame("p1");
    expect(() => locatePanelFrame("p1")).toThrow(/moving/);
  });
});

describe("assertPanelCapturable", () => {
  it("returns the frame's rect when only the panel is under it", () => {
    const frame = mountFrame("p1");
    hitTarget = frame.firstElementChild;

    expect(assertPanelCapturable("p1", frame, "grid")).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  it("refuses while the project view is not on screen", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    viewState.observable = false;
    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(PanelCaptureRefusedError);
  });

  it("refuses a frame that is not painted", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    frame.checkVisibility = () => false;
    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/hidden/);
  });

  it("refuses a frame with no area or one that runs past the window", () => {
    const empty = mountFrame("p1", box(0, 0, 0, 0));
    expect(() => assertPanelCapturable("p1", empty, "grid")).toThrow(/no visible area/);

    const wide = mountFrame("p2", box(1000, 0, 400, 300));
    hitTarget = wide;
    expect(() => assertPanelCapturable("p2", wide, "grid")).toThrow(/past the window/);
  });

  it("refuses while a dialog holds an overlay claim, unless the panel is that dialog's", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    useUIStore.setState({ overlayStack: ["settings"] });

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/close it and retry/);
    expect(() => assertPanelCapturable("p1", frame, "dialog")).not.toThrow();
  });

  it("refuses any portalled layer over the panel, even one hit testing passes through", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    // A toast in the strip between sample rows, and pointer-events: none.
    const toaster = portal(box(0, 0, 0, 0), { role: "region", style: "pointer-events: none" });
    const toast = document.createElement("div");
    toast.textContent = "Saved";
    toast.getBoundingClientRect = () => box(380, 52, 120, 6);
    toaster.appendChild(toast);

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/close it and retry/);
  });

  it("refuses a raised fixed layer inside the app root, like a drag preview", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    const preview = document.createElement("div");
    preview.style.position = "fixed";
    preview.style.zIndex = "999";
    const ghost = document.createElement("div");
    ghost.style.backgroundColor = "rgb(20, 20, 20)";
    ghost.getBoundingClientRect = () => box(150, 100, 40, 40);
    preview.appendChild(ghost);
    appRoot().appendChild(preview);

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/close it and retry/);
  });

  it("ignores layers elsewhere, hidden, transparent, parked behind the app, or inside the panel", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    portal(box(900, 600, 100, 100), { role: "menu", style: "background-color: red" });
    const hidden = portal(box(100, 50, 400, 300), { style: "background-color: red" });
    hidden.checkVisibility = () => false;
    portal(box(0, 0, 2000, 2000), {
      style: "position: fixed; z-index: -1; background-color: red",
    });
    // A closed dropdown's host stays mounted: full-window, but draws nothing.
    portal(box(0, 0, 1200, 800), { style: "position: fixed; z-index: 70; pointer-events: none" });
    const own = document.createElement("div");
    own.setAttribute("role", "listbox");
    own.style.backgroundColor = "red";
    own.getBoundingClientRect = () => box(120, 60, 50, 50);
    frame.appendChild(own);

    expect(() => assertPanelCapturable("p1", frame, "grid")).not.toThrow();
  });

  it("lets a dialog panel through layers beneath it but not one above it", () => {
    useUIStore.setState({ overlayStack: ["panel-dialog-a", "panel-dialog-b"] });
    const scrim = "position: fixed; z-index: 60; background-color: rgba(0, 0, 0, 0.5)";
    portal(box(0, 0, 1200, 800), { role: "dialog", style: scrim });
    const dialog = portal(box(0, 0, 1200, 800), { role: "dialog", style: scrim });
    const frame = mountFrame("p1", box(100, 50, 400, 300), dialog);
    frame.dataset.panelLocation = "dialog";
    hitTarget = frame;

    expect(() => assertPanelCapturable("p1", frame, "dialog")).not.toThrow();

    portal(box(0, 0, 1200, 800), { role: "alertdialog", style: scrim });
    expect(() => assertPanelCapturable("p1", frame, "dialog")).toThrow(/close it and retry/);
  });

  it("refuses a higher layer over a dialog panel even when it was mounted first", () => {
    useUIStore.setState({ overlayStack: ["panel-dialog"] });
    // A toast stack mounts once and stays; its z is above the dialogs'.
    const toaster = portal(box(0, 0, 0, 0), { style: "position: fixed; z-index: 80" });
    const toast = document.createElement("div");
    toast.textContent = "Build failed";
    toast.getBoundingClientRect = () => box(380, 60, 120, 40);
    toaster.appendChild(toast);
    const dialog = portal(box(0, 0, 1200, 800), {
      role: "dialog",
      style: "position: fixed; z-index: 60",
    });
    const frame = mountFrame("p1", box(100, 50, 400, 300), dialog);
    hitTarget = frame;

    expect(() => assertPanelCapturable("p1", frame, "dialog")).toThrow(/close it and retry/);
  });

  it("refuses a frame its scroll container cuts off", () => {
    const scroller = document.createElement("div");
    scroller.style.overflow = "auto";
    scroller.getBoundingClientRect = () => box(100, 60, 400, 400);
    appRoot().appendChild(scroller);
    const frame = mountFrame("p1", box(100, 50, 400, 300), scroller);
    hitTarget = frame;

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/scrolled out of view/);
  });

  it("refuses while the panel or a container of it is partly transparent", () => {
    const fading = document.createElement("div");
    fading.style.opacity = "0.6";
    appRoot().appendChild(fading);
    const frame = mountFrame("p1", box(100, 50, 400, 300), fading);
    hitTarget = frame;

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/animating/);
  });

  it("refuses while an animation is running on the panel or a container of it", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    const effect = { target: appRoot() };
    const setAnimations = (value: () => unknown[]) =>
      Object.defineProperty(document, "getAnimations", { configurable: true, value });
    setAnimations(() => [{ playState: "running", effect }]);

    try {
      expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/animating/);
    } finally {
      setAnimations(() => []);
    }
  });

  it("refuses when anything outside the panel is topmost at a sample point", () => {
    const frame = mountFrame("p1");
    const toast = document.createElement("div");
    document.body.appendChild(toast);
    document.elementFromPoint = vi.fn((x: number, y: number) =>
      x > 400 && y > 300 ? toast : frame
    );

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/close it and retry/);
  });
});

describe("sameRect", () => {
  it("treats a fraction of a pixel as movement, since zoom can carry it across a pixel edge", () => {
    const at = { x: 100, y: 50, width: 400, height: 300 };
    expect(sameRect(at, { ...at })).toBe(true);
    expect(sameRect(at, { ...at, x: 100.4 })).toBe(false);
    expect(sameRect(at, { ...at, height: 299.8 })).toBe(false);
  });
});

describe("consoleMessagesForPlugin", () => {
  const entry = (sourceId: string, message: string, timestamp = 0) => ({
    level: "error" as const,
    message,
    sourceId,
    lineNumber: 4,
    timestamp,
  });

  it("keeps only the plugin's own entries, without query strings", () => {
    runtime.owners.set("pi-a", "acme.dashboard");
    runtime.owners.set("pi-b", "other.plugin");

    const result = consoleMessagesForPlugin(
      [
        entry("plugin://pi-a/__dtv-1/view.js?v=3", "mine"),
        entry("plugin://pi-b/view.js", "theirs"),
        entry("plugin://pi-unknown/view.js", "unregistered"),
      ],
      "acme.dashboard"
    );

    expect(result.omitted).toBe(0);
    expect(result.messages).toEqual([
      {
        level: "error",
        message: "mine",
        source: "plugin://pi-a/__dtv-1/view.js",
        line: 4,
        timestamp: new Date(0).toISOString(),
      },
    ]);
  });

  it("returns the newest entries up to the limit", () => {
    runtime.owners.set("pi-a", "acme.dashboard");
    const entries = Array.from({ length: CAPTURE_CONSOLE_LIMIT + 3 }, (_, i) =>
      entry("plugin://pi-a/view.js", `m${i}`)
    );

    const { messages, omitted } = consoleMessagesForPlugin(entries, "acme.dashboard");
    expect(messages).toHaveLength(CAPTURE_CONSOLE_LIMIT);
    expect(messages[0]?.message).toBe("m3");
    expect(omitted).toBe(3);
  });

  it("keeps whole entries within the byte budget, newest first in, multibyte included", () => {
    runtime.owners.set("pi-a", "acme.dashboard");
    const wide = "界".repeat(2000);
    const entries = Array.from({ length: CAPTURE_CONSOLE_LIMIT }, (_, i) =>
      entry("plugin://pi-a/view.js", `${i}:${wide}`)
    );

    const { messages, omitted } = consoleMessagesForPlugin(entries, "acme.dashboard");
    const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
    expect(bytes).toBeLessThanOrEqual(CAPTURE_CONSOLE_MAX_BYTES + messages.length + 2);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.at(-1)?.message.startsWith(`${CAPTURE_CONSOLE_LIMIT - 1}:`)).toBe(true);
    expect(omitted).toBe(CAPTURE_CONSOLE_LIMIT - messages.length);
  });

  it("scrubs secrets out of the message", () => {
    runtime.owners.set("pi-a", "acme.dashboard");
    const token = `ghp_${"a".repeat(36)}`;
    const {
      messages: [result],
    } = consoleMessagesForPlugin(
      [entry("plugin://pi-a/view.js", `auth failed for ${token}`)],
      "acme.dashboard"
    );
    expect(result?.message).not.toContain(token);
  });
});
