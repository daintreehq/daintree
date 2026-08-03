// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { enqueueFlowStatusUpdate, flushPanelStatusBuffer } from "@/store/panelStatusBuffer";

vi.mock("@/utils/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const { handleBackendCrash, handleBackendRecovery } = vi.hoisted(() => ({
  handleBackendCrash: vi.fn(),
  handleBackendRecovery: vi.fn(),
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { handleBackendCrash, handleBackendRecovery },
}));

const backendReadyHandlers = vi.hoisted(() => [] as Array<() => void>);
const backendCrashedHandlers = vi.hoisted(() => [] as Array<(details: unknown) => void>);
vi.mock("@/controllers", () => {
  const noopSub = () => () => {};
  return {
    terminalRegistryController: {
      onBackendCrashed: vi.fn((handler: (details: unknown) => void) => {
        backendCrashedHandlers.push(handler);
        return () => {};
      }),
      onBackendRecovering: vi.fn(noopSub),
      onBackendReady: vi.fn((handler: () => void) => {
        backendReadyHandlers.push(handler);
        return () => {};
      }),
    },
  };
});

import { setupBackendHealthListeners } from "../backendHealth";

function getBackendReadyHandler(): () => void {
  backendReadyHandlers.length = 0;
  setupBackendHealthListeners();
  const handler = backendReadyHandlers.at(-1);
  if (!handler) throw new Error("onBackendReady handler was not registered");
  return handler;
}

function getBackendCrashedHandler(): (details: unknown) => void {
  backendCrashedHandlers.length = 0;
  setupBackendHealthListeners();
  const handler = backendCrashedHandlers.at(-1);
  if (!handler) throw new Error("onBackendCrashed handler was not registered");
  return handler;
}

function getPanel(id: string) {
  const panel = usePanelStore.getState().panelsById[id];
  if (!panel || !isPtyPanel(panel)) return undefined;
  return panel;
}

const ptyBase = {
  kind: "terminal" as const,
  title: "Terminal",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  location: "grid" as const,
};

beforeEach(() => {
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("onBackendCrashed — stale PTY geometry echoes dropped (#11641)", () => {
  it("invalidates every pane's echo at crash time, not at recovery", () => {
    getBackendCrashedHandler()({ crashType: "SIGNAL_TERMINATED" });

    // The renderer keeps resizing panes for the whole outage, so waiting for
    // onBackendReady would leave a dead PTY's geometry comparable against a
    // live xterm grid for exactly the window the logs matter in.
    expect(handleBackendCrash).toHaveBeenCalledTimes(1);
    expect(handleBackendRecovery).not.toHaveBeenCalled();
    expect(usePanelStore.getState().backendStatus).toBe("disconnected");
  });
});

describe("onBackendReady — stale flow state cleared on host recovery (#9899)", () => {
  it("clears flow fields and re-derives runtimeStatus on a paused PTY panel", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          ...ptyBase,
          id: "term-1",
          isVisible: true,
          flowStatus: "paused-backpressure",
          flowStatusTimestamp: 999,
          heldDurationMs: 5000,
          runtimeStatus: "paused-backpressure",
        },
      },
      panelIds: ["term-1"],
    });

    getBackendReadyHandler()();

    const panel = getPanel("term-1");
    expect(panel?.flowStatus).toBeUndefined();
    expect(panel?.flowStatusTimestamp).toBeUndefined();
    expect(panel?.heldDurationMs).toBeUndefined();
    // Visible, non-exited panel with no flow status derives back to "running".
    expect(panel?.runtimeStatus).toBe("running");
  });

  it("clears flow state across multiple paused PTY panels in one pass", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          ...ptyBase,
          id: "term-1",
          isVisible: true,
          flowStatus: "paused-backpressure",
          runtimeStatus: "paused-backpressure",
        },
        // FUTURE_SAB: this test originally used `flowStatus: "suspended"`
        // (and `runtimeStatus: "suspended"`) as a representative non-running
        // status to assert the host-recovery clear pass. As of #9900 the
        // panel-store types exclude `suspended` from `PersistableFlowStatus`
        // (no production producer), so we substitute a persistable value
        // here. The test's intent — multi-panel clear in one pass — is
        // preserved.
        "term-2": {
          ...ptyBase,
          id: "term-2",
          isVisible: false,
          flowStatus: "paused-resource-governor",
          runtimeStatus: "paused-resource-governor",
        },
      },
      panelIds: ["term-1", "term-2"],
    });

    getBackendReadyHandler()();

    expect(getPanel("term-1")?.flowStatus).toBeUndefined();
    expect(getPanel("term-1")?.runtimeStatus).toBe("running");
    expect(getPanel("term-2")?.flowStatus).toBeUndefined();
    // Backgrounded panel derives to "background", not "running".
    expect(getPanel("term-2")?.runtimeStatus).toBe("background");
  });

  it("preserves runtimeStatus on exited panels (does not revive them)", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          ...ptyBase,
          id: "term-1",
          isVisible: true,
          flowStatus: "paused-backpressure",
          runtimeStatus: "exited",
        },
      },
      panelIds: ["term-1"],
    });

    getBackendReadyHandler()();

    const panel = getPanel("term-1");
    expect(panel?.flowStatus).toBeUndefined();
    expect(panel?.runtimeStatus).toBe("exited");
  });

  it("leaves non-PTY panels untouched", () => {
    const browserPanel = {
      id: "browser-1",
      kind: "browser" as const,
      title: "Browser",
      location: "grid" as const,
      url: "https://example.com",
    };
    usePanelStore.setState({
      panelsById: { "browser-1": browserPanel },
      panelIds: ["browser-1"],
    });

    getBackendReadyHandler()();

    expect(usePanelStore.getState().panelsById["browser-1"]).toEqual(browserPanel);
  });

  it("a flow patch buffered before the crash does not resurrect the pill after recovery", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          ...ptyBase,
          id: "term-1",
          isVisible: true,
          runtimeStatus: "running",
        },
      },
      panelIds: ["term-1"],
    });

    // A flow event was enqueued just before the host crashed; it never flushed.
    enqueueFlowStatusUpdate("term-1", "paused-backpressure", 999);

    getBackendReadyHandler()();

    // Recovery cancels the buffer; a later flush must not write the stale patch.
    flushPanelStatusBuffer();

    expect(getPanel("term-1")?.flowStatus).toBeUndefined();
    expect(getPanel("term-1")?.runtimeStatus).toBe("running");
  });

  it("does not rewrite already-clean PTY panels (referential stability)", () => {
    const clean = {
      ...ptyBase,
      id: "term-1",
      isVisible: true,
      runtimeStatus: "running" as const,
    };
    usePanelStore.setState({
      panelsById: { "term-1": clean },
      panelIds: ["term-1"],
    });

    getBackendReadyHandler()();

    // Same object reference — no spurious setState write for an unchanged panel.
    expect(usePanelStore.getState().panelsById["term-1"]).toBe(clean);
  });
});
