// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const systemClientMock = vi.hoisted(() => ({ openExternal: vi.fn() }));
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const consoleCaptureMock = vi.hoisted(() => ({ getState: vi.fn(), flush: vi.fn() }));

vi.mock("@/clients", () => ({ systemClient: systemClientMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/consoleCaptureStore", () => ({
  useConsoleCaptureStore: { getState: consoleCaptureMock.getState },
  flushConsoleCaptureBuffer: consoleCaptureMock.flush,
}));

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

const getMessagesSpy = vi.fn();
const getCountsSpy = vi.fn();

interface FakeRow {
  id: number;
  paneId: string;
  level: "log" | "info" | "warning" | "error";
  cdpType: string;
  args: unknown[];
  summaryText: string;
  stackTrace?: unknown;
  groupDepth: number;
  timestamp: number;
  navigationGeneration: number;
  category?: string;
  // Renderer-only UI fields that must be stripped from the action result.
  isStale: boolean;
  timeLabel: string;
  isGroupHeader: boolean;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 1,
    paneId: "b1",
    level: "log",
    cdpType: "log",
    args: [],
    summaryText: "message",
    groupDepth: 0,
    timestamp: 0,
    navigationGeneration: 0,
    isStale: false,
    timeLabel: "00:00:00.000",
    isGroupHeader: false,
    ...overrides,
  };
}

function setConsoleState(
  rows: FakeRow[],
  counts: { errorCount: number; warnCount: number } = { errorCount: 0, warnCount: 0 }
) {
  getMessagesSpy.mockReturnValue(rows);
  getCountsSpy.mockReturnValue(counts);
  consoleCaptureMock.getState.mockReturnValue({
    getMessages: getMessagesSpy,
    getCounts: getCountsSpy,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  clipboardSpy.mockReset().mockResolvedValue(undefined);
  addPanelSpy.mockReset().mockResolvedValue("new-panel");
  setBrowserUrlSpy.mockReset();
  activateTerminalSpy.mockReset();
  getMessagesSpy.mockReset();
  getCountsSpy.mockReset();
  consoleCaptureMock.flush.mockReset();
  consoleCaptureMock.getState.mockReset();
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

  it("browser.openUrl does not reuse a dev-preview panel — it creates a browser panel", async () => {
    setPanelState({
      panelIds: ["dp1"],
      panelsById: { dp1: { id: "dp1", kind: "dev-preview" } },
    });
    const run = setupActions();
    await run("browser.openUrl", { url: "https://fresh.example" });

    expect(addPanelSpy).toHaveBeenCalledTimes(1);
    expect(setBrowserUrlSpy).not.toHaveBeenCalled();
  });

  it("browser.openUrl skips stale panelIds with no panelsById entry and reuses the real browser", async () => {
    setPanelState({
      panelIds: ["stale", "b1"],
      panelsById: { b1: { id: "b1", kind: "browser" } },
    });
    const run = setupActions();
    await run("browser.openUrl", { url: "https://new.example" });

    expect(setBrowserUrlSpy).toHaveBeenCalledWith("b1", "https://new.example");
    expect(addPanelSpy).not.toHaveBeenCalled();
  });

  it("browser.openUrl throws when addPanel returns null (panel limit reached)", async () => {
    setPanelState({ panelIds: [], panelsById: {} });
    addPanelSpy.mockResolvedValue(null);
    const run = setupActions();

    await expect(run("browser.openUrl", { url: "https://fresh.example" })).rejects.toThrow(
      /panel limit/
    );
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

  // Console-read tests seed a dev-preview panel as the target since only
  // dev-preview panels capture console output.
  function devPreviewPanels(ids: string[]): Record<string, { id: string; kind: string }> {
    return Object.fromEntries(ids.map((id) => [id, { id, kind: "dev-preview" }]));
  }

  it("browser.getConsoleMessages returns messages and counts for the focused pane", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([makeRow({ id: 1, summaryText: "hello" })], { errorCount: 2, warnCount: 1 });
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages")) as {
      paneId: string;
      messages: Array<{ id: number; summaryText: string }>;
      counts: { errorCount: number; warnCount: number };
    };

    expect(getMessagesSpy).toHaveBeenCalledWith("b1");
    expect(result.paneId).toBe("b1");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: 1, summaryText: "hello" });
    expect(result.counts).toEqual({ errorCount: 2, warnCount: 1 });
  });

  it("browser.getConsoleMessages strips renderer-only UI fields", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([makeRow()]);
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages")) as {
      messages: Array<Record<string, unknown>>;
    };

    const msg = result.messages[0]!;
    expect(msg).not.toHaveProperty("isStale");
    expect(msg).not.toHaveProperty("timeLabel");
    expect(msg).not.toHaveProperty("isGroupHeader");
  });

  it("browser.getConsoleMessages flushes the ingest buffer before reading", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([makeRow()]);
    const run = setupActions();
    await run("browser.getConsoleMessages");

    expect(consoleCaptureMock.flush).toHaveBeenCalledTimes(1);
    const flushOrder = consoleCaptureMock.flush.mock.invocationCallOrder[0]!;
    const readOrder = getMessagesSpy.mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(readOrder);
  });

  it("browser.getConsoleMessages filters by level", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([
      makeRow({ id: 1, level: "log" }),
      makeRow({ id: 2, level: "error" }),
      makeRow({ id: 3, level: "error" }),
    ]);
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages", { level: "error" })) as {
      messages: Array<{ id: number; level: string }>;
    };

    expect(result.messages.map((m) => m.id)).toEqual([2, 3]);
  });

  it("browser.getConsoleMessages applies limit to the most recent rows after filtering", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([
      makeRow({ id: 1 }),
      makeRow({ id: 2 }),
      makeRow({ id: 3 }),
      makeRow({ id: 4 }),
    ]);
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages", { limit: 2 })) as {
      messages: Array<{ id: number }>;
    };

    expect(result.messages.map((m) => m.id)).toEqual([3, 4]);
  });

  it("browser.getConsoleMessages applies limit to the most recent rows of the filtered level", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([
      makeRow({ id: 1, level: "log" }),
      makeRow({ id: 2, level: "error" }),
      makeRow({ id: 3, level: "log" }),
      makeRow({ id: 4, level: "error" }),
      makeRow({ id: 5, level: "error" }),
    ]);
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages", { level: "error", limit: 2 })) as {
      messages: Array<{ id: number }>;
    };

    // Must be the last 2 errors (4, 5), not the last 2 rows — filter before limit.
    expect(result.messages.map((m) => m.id)).toEqual([4, 5]);
  });

  it("browser.getConsoleMessages uses explicit terminalId over focus", async () => {
    setPanelState({ focusedId: "focused", panelsById: devPreviewPanels(["focused", "other"]) });
    setConsoleState([]);
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages", { terminalId: "other" })) as {
      paneId: string;
    };

    expect(getMessagesSpy).toHaveBeenCalledWith("other");
    expect(result.paneId).toBe("other");
  });

  it("browser.getConsoleMessages returns empty result for a pane with no messages", async () => {
    setPanelState({ focusedId: "b1", panelsById: devPreviewPanels(["b1"]) });
    setConsoleState([]);
    const run = setupActions();
    const result = (await run("browser.getConsoleMessages")) as {
      messages: unknown[];
      counts: { errorCount: number; warnCount: number };
    };

    expect(result.messages).toEqual([]);
    expect(result.counts).toEqual({ errorCount: 0, warnCount: 0 });
  });

  it("browser.getConsoleMessages throws when no target panel exists", async () => {
    setPanelState({ focusedId: null });
    const run = setupActions();

    await expect(run("browser.getConsoleMessages")).rejects.toThrow(/No dev preview panel/);
    expect(consoleCaptureMock.flush).not.toHaveBeenCalled();
  });

  it("browser.getConsoleMessages throws for a non-dev-preview target instead of returning empty", async () => {
    setPanelState({
      focusedId: "t1",
      panelsById: { t1: { id: "t1", kind: "terminal" } },
    });
    setConsoleState([makeRow()]);
    const run = setupActions();

    await expect(run("browser.getConsoleMessages")).rejects.toThrow(/dev preview panels/);
    expect(consoleCaptureMock.flush).not.toHaveBeenCalled();
    expect(getMessagesSpy).not.toHaveBeenCalled();
  });
});
