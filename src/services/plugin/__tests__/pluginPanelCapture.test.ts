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
  PanelCaptureRefusedError,
  assertPanelCapturable,
  consoleMessagesForPlugin,
  locatePanelFrame,
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

function mountFrame(panelId: string, rect = box(100, 50, 400, 300)): HTMLElement {
  const frame = document.createElement("div");
  frame.dataset.panelId = panelId;
  frame.dataset.panelLocation = "grid";
  const inner = document.createElement("div");
  frame.appendChild(inner);
  frame.getBoundingClientRect = () => rect;
  document.body.appendChild(frame);
  return frame;
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
    expect(() => locatePanelFrame("p1")).toThrow(/not on screen/);
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

  it("refuses a floating layer over the panel, even one hit testing passes through", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    const tooltip = document.createElement("div");
    tooltip.setAttribute("role", "tooltip");
    tooltip.getBoundingClientRect = () => box(480, 60, 80, 20);
    document.body.appendChild(tooltip);

    expect(() => assertPanelCapturable("p1", frame, "grid")).toThrow(/close it and retry/);
  });

  it("ignores floating layers elsewhere, inside the panel, or hosting it", () => {
    const frame = mountFrame("p1");
    hitTarget = frame;
    const far = document.createElement("div");
    far.setAttribute("role", "menu");
    far.getBoundingClientRect = () => box(900, 600, 100, 100);
    document.body.appendChild(far);
    const own = document.createElement("div");
    own.setAttribute("role", "listbox");
    own.getBoundingClientRect = () => box(120, 60, 50, 50);
    frame.appendChild(own);

    expect(() => assertPanelCapturable("p1", frame, "grid")).not.toThrow();
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

    expect(result).toEqual([
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

    const result = consoleMessagesForPlugin(entries, "acme.dashboard");
    expect(result).toHaveLength(CAPTURE_CONSOLE_LIMIT);
    expect(result[0]?.message).toBe("m3");
  });

  it("scrubs secrets out of the message", () => {
    runtime.owners.set("pi-a", "acme.dashboard");
    const token = `ghp_${"a".repeat(36)}`;
    const [result] = consoleMessagesForPlugin(
      [entry("plugin://pi-a/view.js", `auth failed for ${token}`)],
      "acme.dashboard"
    );
    expect(result?.message).not.toContain(token);
  });
});
