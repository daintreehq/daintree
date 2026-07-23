// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const flushPanelPersistenceMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/slices", () => ({
  flushPanelPersistence: flushPanelPersistenceMock,
}));

const flushDraftsMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/persistence/draftInputPersistence", () => ({
  draftInputPersistence: { flushAll: flushDraftsMock },
}));

vi.mock("@/store/resourceMonitoringStore", () => ({
  useResourceMonitoringStore: {
    getState: () => ({ enabled: false, updateMetrics: vi.fn() }),
  },
}));

const { setupResourceListeners } = await import("../resource");

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

describe("setupResourceListeners — persistence flush on hide (#9914)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { window: Window }).window.electron = {
      terminal: {
        onResourceMetrics: vi.fn(() => () => {}),
      },
    } as unknown as Window["electron"];
  });

  afterEach(() => {
    setHidden(false);
  });

  it("flushes panel and draft persistence when the document becomes hidden", () => {
    const d = setupResourceListeners();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushPanelPersistenceMock).toHaveBeenCalledTimes(1);
    expect(flushDraftsMock).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("does not flush while the document is still visible", () => {
    const d = setupResourceListeners();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushPanelPersistenceMock).not.toHaveBeenCalled();
    expect(flushDraftsMock).not.toHaveBeenCalled();
    d.dispose();
  });

  it("removes the listener on dispose — no flush after teardown", () => {
    const d = setupResourceListeners();
    d.dispose();

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(flushPanelPersistenceMock).not.toHaveBeenCalled();
    expect(flushDraftsMock).not.toHaveBeenCalled();
  });

  it("flushes both immediately when the document is already hidden at registration", () => {
    setHidden(true);
    const d = setupResourceListeners();

    expect(flushPanelPersistenceMock).toHaveBeenCalledTimes(1);
    expect(flushDraftsMock).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("does not register a beforeunload handler (the unreliable signal it replaced)", () => {
    const windowSpy = vi.spyOn(window, "addEventListener");
    const documentSpy = vi.spyOn(document, "addEventListener");
    const d = setupResourceListeners();

    expect(windowSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    expect(documentSpy.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    d.dispose();
    windowSpy.mockRestore();
    documentSpy.mockRestore();
  });
});
