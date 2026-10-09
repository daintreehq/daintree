// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Panels = Record<string, Record<string, unknown>>;

const panelStore = vi.hoisted(() => {
  let state: { panelsById: Panels } = { panelsById: {} };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setPanels: (panelsById: Panels) => {
      state = { panelsById };
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("../panelStore", () => ({ usePanelStore: panelStore }));

import { useMacroFocusStore } from "../macroFocusStore";
import { readFocusedPanel, subscribeFocusedPanelReporter } from "../focusedPanelReporter";

const setPanels = panelStore.setPanels;

function setElectron(value: unknown): void {
  Object.defineProperty(window, "electron", { value, configurable: true, writable: true });
}

function mountPanel(id: string): HTMLButtonElement {
  const root = document.createElement("div");
  root.setAttribute("data-panel-id", id);
  const inner = document.createElement("button");
  root.appendChild(inner);
  document.body.appendChild(root);
  return inner;
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

let hasFocus: ReturnType<typeof vi.spyOn>;
let report: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  report = vi.fn();
  setElectron({ plugin: { reportFocusedPanel: report } });
  setPanels({
    t1: { id: "t1", kind: "terminal", worktreeId: "wt-1", detectedAgentId: "claude" },
    b1: { id: "b1", kind: "browser", worktreeId: "wt-1", title: "Secret page" },
    x1: { id: "x1", kind: "acme.timeline", worktreeId: "wt-2" },
    pt1: {
      id: "pt1",
      kind: "terminal",
      pluginPanelKindId: "acme.console",
      worktreeId: "wt-2",
      detectedAgentId: "claude",
    },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  hasFocus.mockRestore();
  useMacroFocusStore.getState().setRegionRef("portal", null);
  Reflect.deleteProperty(window, "electron");
});

describe("readFocusedPanel", () => {
  it("reads the panel holding DOM focus, never focusedId", () => {
    mountPanel("t1").focus();
    expect(readFocusedPanel()).toEqual({ kind: "terminal", agent: true, worktreeId: "wt-1" });
  });

  it("collapses a plugin panel's kind and drops everything but the allowlist", () => {
    mountPanel("x1").focus();
    expect(readFocusedPanel()).toStrictEqual({ kind: "plugin", agent: false, worktreeId: "wt-2" });
    mountPanel("b1").focus();
    expect(readFocusedPanel()).toStrictEqual({ kind: "browser", agent: false, worktreeId: "wt-1" });
    mountPanel("pt1").focus();
    expect(readFocusedPanel()).toStrictEqual({ kind: "plugin", agent: false, worktreeId: "wt-2" });
  });

  it("is null when focus is outside every panel or the document is not focused", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(readFocusedPanel().kind).toBeNull();

    mountPanel("t1").focus();
    hasFocus.mockReturnValue(false);
    expect(readFocusedPanel().kind).toBeNull();
  });

  it("reports the Portal dock's own chrome as portal", () => {
    const dock = document.createElement("aside");
    const tab = document.createElement("button");
    dock.appendChild(tab);
    document.body.appendChild(dock);
    useMacroFocusStore.getState().setRegionRef("portal", dock);
    tab.focus();

    expect(readFocusedPanel()).toEqual({ kind: "portal", agent: false, worktreeId: null });
  });
});

describe("subscribeFocusedPanelReporter", () => {
  it("reports on focus moves and on store changes, deduped", async () => {
    const terminal = mountPanel("t1");
    const browser = mountPanel("b1");
    const dispose = subscribeFocusedPanelReporter();
    await flushMicrotasks();
    expect(report).toHaveBeenLastCalledWith({ kind: null, agent: false, worktreeId: null });

    terminal.focus();
    await flushMicrotasks();
    browser.focus();
    await flushMicrotasks();
    expect(report.mock.calls.map(([r]) => r.kind)).toEqual([null, "terminal", "browser"]);

    // The agent in the focused terminal exits: no focus move, still a change.
    terminal.focus();
    await flushMicrotasks();
    setPanels({ t1: { id: "t1", kind: "terminal", worktreeId: "wt-1" } });
    await flushMicrotasks();
    expect(report).toHaveBeenLastCalledWith({ kind: "terminal", agent: false, worktreeId: "wt-1" });

    const calls = report.mock.calls.length;
    setPanels({ t1: { id: "t1", kind: "terminal", worktreeId: "wt-1", title: "renamed" } });
    await flushMicrotasks();
    expect(report).toHaveBeenCalledTimes(calls);

    dispose();
    browser.focus();
    await flushMicrotasks();
    expect(report).toHaveBeenCalledTimes(calls);
  });

  it("re-sends an unchanged answer when the view becomes visible again", async () => {
    mountPanel("t1").focus();
    const dispose = subscribeFocusedPanelReporter();
    await flushMicrotasks();
    const calls = report.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));
    await flushMicrotasks();
    expect(report).toHaveBeenCalledTimes(calls + 1);
    dispose();
  });

  it("is inert without the preload binding", () => {
    Reflect.deleteProperty(window, "electron");
    expect(() => subscribeFocusedPanelReporter()()).not.toThrow();
  });
});
