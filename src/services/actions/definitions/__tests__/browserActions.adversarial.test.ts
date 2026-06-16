// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const systemClientMock = vi.hoisted(() => ({ openExternal: vi.fn() }));
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/clients", () => ({ systemClient: systemClientMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));

import { registerBrowserActions } from "../browserActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerBrowserActions(actions, callbacks);
  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

const addPanelSpy = vi.fn<(options: unknown) => Promise<string | null>>();
const setBrowserUrlSpy = vi.fn<(id: string, url: string) => void>();
const activateTerminalSpy = vi.fn<(id: string | null) => void>();

function setPanelState(state: {
  focusedId?: string | null;
  panelsById?: Record<string, { id?: string; browserUrl?: string; kind?: string }>;
  panelIds?: string[];
}) {
  panelStoreMock.getState.mockReturnValue({
    focusedId: state.focusedId ?? null,
    panelsById: state.panelsById ?? {},
    panelIds: state.panelIds ?? [],
    addPanel: addPanelSpy,
    setBrowserUrl: setBrowserUrlSpy,
    activateTerminal: activateTerminalSpy,
  });
}

const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);
const clipboardSpy = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  clipboardSpy.mockReset().mockResolvedValue(undefined);
  addPanelSpy.mockReset().mockResolvedValue("new-panel");
  setBrowserUrlSpy.mockReset();
  activateTerminalSpy.mockReset();
  systemClientMock.openExternal.mockResolvedValue(undefined);
  Object.defineProperty(globalThis.window, "dispatchEvent", {
    value: dispatchSpy,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: clipboardSpy } },
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
});

describe("browserActions adversarial", () => {
  it("browser.navigate uses focusedId when no explicit terminalId is provided", async () => {
    setPanelState({ focusedId: "b1", panelsById: { b1: {} } });
    const run = setupActions();
    await run("browser.navigate", { url: "https://a.example" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { id: string; url: string };
    };
    expect(event.type).toBe("daintree:browser-navigate");
    expect(event.detail).toEqual({ id: "b1", url: "https://a.example" });
  });

  it("browser.navigate explicit terminalId overrides focusedId", async () => {
    setPanelState({ focusedId: "b1" });
    const run = setupActions();
    await run("browser.navigate", { url: "https://a.example", terminalId: "b2" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      detail: { id: string };
    };
    expect(event.detail.id).toBe("b2");
  });

  it("browser.navigate throws when no target panel exists (no silent ok:true)", async () => {
    setPanelState({ focusedId: null });
    const run = setupActions();

    await expect(run("browser.navigate", { url: "https://a.example" })).rejects.toThrow(
      /No browser panel/
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("browser.openUrl reuses an existing browser panel instead of creating one", async () => {
    setPanelState({
      panelIds: ["t1", "b1"],
      panelsById: {
        t1: { id: "t1", kind: "terminal" },
        b1: { id: "b1", kind: "browser", browserUrl: "https://old.example" },
      },
    });
    const run = setupActions();
    await run("browser.openUrl", { url: "https://new.example" });

    expect(setBrowserUrlSpy).toHaveBeenCalledWith("b1", "https://new.example");
    expect(activateTerminalSpy).toHaveBeenCalledWith("b1");
    expect(addPanelSpy).not.toHaveBeenCalled();
  });

  it("browser.openUrl creates a new browser panel when none exists (no focusPolicy)", async () => {
    setPanelState({
      panelIds: ["t1"],
      panelsById: { t1: { id: "t1", kind: "terminal" } },
    });
    const run = setupActions();
    await run("browser.openUrl", { url: "https://fresh.example" });

    expect(addPanelSpy).toHaveBeenCalledTimes(1);
    const options = addPanelSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toEqual({ kind: "browser", browserUrl: "https://fresh.example" });
    expect(options.focusPolicy).toBeUndefined();
    expect(setBrowserUrlSpy).not.toHaveBeenCalled();
  });

  it("browser.back with no target is a silent no-op (no event dispatched)", async () => {
    setPanelState({ focusedId: null });
    const run = setupActions();
    await run("browser.back");
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("browser.openExternal explicit url wins over stale store browserUrl", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: { kind: "browser", browserUrl: "https://stale.example" } },
    });
    const run = setupActions();
    await run("browser.openExternal", { url: "https://fresh.example" });

    expect(systemClientMock.openExternal).toHaveBeenCalledWith("https://fresh.example");
  });

  it("browser.openExternal falls back to stored browserUrl when no explicit url is given", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: { kind: "browser", browserUrl: "https://stored.example" } },
    });
    const run = setupActions();
    await run("browser.openExternal");

    expect(systemClientMock.openExternal).toHaveBeenCalledWith("https://stored.example");
  });

  it("browser.openExternal throws when neither explicit url nor stored browserUrl exists", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: { kind: "browser" } },
    });
    const run = setupActions();

    await expect(run("browser.openExternal")).rejects.toThrow(/No browser URL/);
    expect(systemClientMock.openExternal).not.toHaveBeenCalled();
  });

  it("browser.copyUrl throws when no url is derivable", async () => {
    setPanelState({ focusedId: null });
    const run = setupActions();

    await expect(run("browser.copyUrl")).rejects.toThrow(/No browser URL/);
    expect(clipboardSpy).not.toHaveBeenCalled();
  });

  it("browser.copyUrl writes to clipboard when url is derivable", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: { kind: "browser", browserUrl: "https://copy.example" } },
    });
    const run = setupActions();
    await run("browser.copyUrl");

    expect(clipboardSpy).toHaveBeenCalledWith("https://copy.example");
  });

  it("browser.setZoomLevel dispatches with validated zoomFactor", async () => {
    setPanelState({ focusedId: "b1" });
    const run = setupActions();
    await run("browser.setZoomLevel", { zoomFactor: 1.5 });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { id: string; zoomFactor: number };
    };
    expect(event.type).toBe("daintree:browser-set-zoom");
    expect(event.detail.zoomFactor).toBe(1.5);
  });

  it("browser.setZoomLevel with no target is a silent no-op", async () => {
    setPanelState({ focusedId: null });
    const run = setupActions();
    await run("browser.setZoomLevel", { zoomFactor: 1.0 });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("browser.reload with explicit terminalId dispatches to that id regardless of focus", async () => {
    setPanelState({ focusedId: "focused" });
    const run = setupActions();
    await run("browser.reload", { terminalId: "other" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      detail: { id: string };
    };
    expect(event.detail.id).toBe("other");
  });

  it("browser.toggleDevTools with no target is a silent no-op", async () => {
    setPanelState({ focusedId: null });
    const run = setupActions();
    await run("browser.toggleDevTools");
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
