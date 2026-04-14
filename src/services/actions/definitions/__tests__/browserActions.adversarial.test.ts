// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

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
    const def = factory() as ActionDefinition<unknown, unknown>;
    return def.run(args, {} as never);
  };
}

function setPanelState(state: {
  focusedId?: string | null;
  panelsById?: Record<string, { browserUrl?: string; kind?: string }>;
}) {
  panelStoreMock.getState.mockReturnValue({
    focusedId: state.focusedId ?? null,
    panelsById: state.panelsById ?? {},
  });
}

const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);
const clipboardSpy = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  clipboardSpy.mockReset().mockResolvedValue(undefined);
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

    const event = dispatchSpy.mock.calls[0][0] as unknown as {
      type: string;
      detail: { id: string; url: string };
    };
    expect(event.type).toBe("canopy:browser-navigate");
    expect(event.detail).toEqual({ id: "b1", url: "https://a.example" });
  });

  it("browser.navigate explicit terminalId overrides focusedId", async () => {
    setPanelState({ focusedId: "b1" });
    const run = setupActions();
    await run("browser.navigate", { url: "https://a.example", terminalId: "b2" });

    const event = dispatchSpy.mock.calls[0][0] as unknown as {
      detail: { id: string };
    };
    expect(event.detail.id).toBe("b2");
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
      panelsById: { b1: { browserUrl: "https://stale.example" } },
    });
    const run = setupActions();
    await run("browser.openExternal", { url: "https://fresh.example" });

    expect(systemClientMock.openExternal).toHaveBeenCalledWith("https://fresh.example");
  });

  it("browser.openExternal falls back to stored browserUrl when no explicit url is given", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: { browserUrl: "https://stored.example" } },
    });
    const run = setupActions();
    await run("browser.openExternal");

    expect(systemClientMock.openExternal).toHaveBeenCalledWith("https://stored.example");
  });

  it("browser.openExternal throws when neither explicit url nor stored browserUrl exists", async () => {
    setPanelState({
      focusedId: "b1",
      panelsById: { b1: {} },
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
      panelsById: { b1: { browserUrl: "https://copy.example" } },
    });
    const run = setupActions();
    await run("browser.copyUrl");

    expect(clipboardSpy).toHaveBeenCalledWith("https://copy.example");
  });

  it("browser.setZoomLevel dispatches with validated zoomFactor", async () => {
    setPanelState({ focusedId: "b1" });
    const run = setupActions();
    await run("browser.setZoomLevel", { zoomFactor: 1.5 });

    const event = dispatchSpy.mock.calls[0][0] as unknown as {
      type: string;
      detail: { id: string; zoomFactor: number };
    };
    expect(event.type).toBe("canopy:browser-set-zoom");
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

    const event = dispatchSpy.mock.calls[0][0] as unknown as {
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
