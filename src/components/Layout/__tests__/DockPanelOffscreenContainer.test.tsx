// @vitest-environment jsdom
/**
 * DockPanelOffscreenContainer — stable-wrapper relocation (#9927).
 *
 * Each dock panel renders into a single stable wrapper that is the permanent
 * createPortal container. Opening/closing a popover relocates that wrapper in
 * the DOM (offscreen ↔ popover) via moveToDestination — it must NOT remount the
 * panel subtree. These tests assert DOM-node identity is preserved across
 * open/close/open cycles and that the moveBefore path and its appendChild
 * fallback both land the wrapper in the destination.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

const closeDockTerminalMock = vi.fn();

const mockState: Record<string, unknown> = {};

vi.mock("zustand/react/shallow", () => ({
  useShallow: <T,>(fn: T) => fn,
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: null }),
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: (selector: (s: { terminalId: string | null }) => unknown) =>
    selector({ terminalId: null }),
}));

// Mock the panel body but keep it a REAL consumer of DragHandleContext, so the
// bridge tests below prove the drag handle actually crosses the createPortal
// boundary (#10990) rather than asserting against a mocked hook.
vi.mock("@/components/Terminal/DockedPanel", async () => {
  const { useDragHandle } = await import("@/components/DragDrop/DragHandleContext");
  return {
    DockedPanel: ({ terminal }: { terminal: PtyPanelData }) => {
      const dragHandle = useDragHandle();
      return (
        <div
          data-testid="docked-panel"
          data-pid={terminal.id}
          data-has-listeners={dragHandle?.listeners ? "true" : "false"}
          data-has-activator={dragHandle?.setActivatorNodeRef ? "true" : "false"}
        />
      );
    },
  };
});

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: vi.fn(),
  canDuplicatePanelKind: vi.fn(() => true),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

vi.mock("@/components/ui/DockPopoverChildContext", () => ({
  DockPopoverChildProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DockPanelOffscreenContainer } from "../DockPanelOffscreenContainer";
import {
  useDockPanelPortal,
  useDockPanelDragHandleRegistration,
  type DockPanelContextValue,
} from "../dockPanelPortalContext";

function makePanel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "panel-1",
    title: "Terminal",
    location: "dock",
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    worktreeId: null,
    ...overrides,
  } as PtyPanelData;
}

function setPanels(panels: PtyPanelData[]) {
  mockState.panelIds = panels.map((p) => p.id);
  mockState.panelsById = Object.fromEntries(panels.map((p) => [p.id, p]));
  mockState.trashedTerminals = new Set<string>();
  mockState.activeDockTerminalId = null;
  mockState.closeDockTerminal = closeDockTerminalMock;
  mockState.addPanel = vi.fn();
  mockState.trashPanel = vi.fn();
  mockState.getPanelGroup = vi.fn(() => undefined);
  mockState.createTabGroup = vi.fn();
  mockState.addPanelToGroup = vi.fn(() => true);
  mockState.deleteTabGroup = vi.fn();
  mockState.setActiveTab = vi.fn();
}

let captured: ((panelId: string, destination: HTMLElement | null) => void) | null = null;
function Capture() {
  captured = useDockPanelPortal();
  return null;
}

let capturedRegister: DockPanelContextValue["registerDragHandle"] | null = null;
function CaptureRegister() {
  capturedRegister = useDockPanelDragHandleRegistration();
  return null;
}

function renderContainer() {
  captured = null;
  return render(
    <DockPanelOffscreenContainer>
      <Capture />
    </DockPanelOffscreenContainer>
  );
}

describe("DockPanelOffscreenContainer stable-wrapper relocation (#9927)", () => {
  beforeEach(() => {
    closeDockTerminalMock.mockClear();
    setPanels([makePanel({ id: "panel-1" })]);
  });

  it("renders each panel into a stable wrapper parked in the offscreen container", () => {
    renderContainer();

    const panel = document.querySelector('[data-testid="docked-panel"]');
    expect(panel).not.toBeNull();
    const wrapper = panel!.closest('[data-dock-panel-wrapper="panel-1"]');
    expect(wrapper).not.toBeNull();

    const offscreen = document.querySelector(".dock-panel-offscreen-container");
    expect(offscreen).not.toBeNull();
    expect(wrapper!.parentElement).toBe(offscreen);
  });

  it("preserves the panel subtree DOM node across open/close/open cycles", () => {
    renderContainer();

    const initial = document.querySelector('[data-testid="docked-panel"]')!;
    const wrapper = initial.closest('[data-dock-panel-wrapper="panel-1"]')!;
    const offscreen = document.querySelector(".dock-panel-offscreen-container")!;

    const target = document.createElement("div");
    document.body.appendChild(target);

    // Open: wrapper relocates into the popover destination; the panel node is
    // the SAME element — no remount.
    act(() => captured!("panel-1", target));
    expect(wrapper.parentElement).toBe(target);
    expect(document.querySelector('[data-testid="docked-panel"]')).toBe(initial);

    // Close: parks back to the offscreen container, still the same node.
    act(() => captured!("panel-1", null));
    expect(wrapper.parentElement).toBe(offscreen);
    expect(document.querySelector('[data-testid="docked-panel"]')).toBe(initial);

    // Re-open: relocates again, still the same node.
    act(() => captured!("panel-1", target));
    expect(wrapper.parentElement).toBe(target);
    expect(document.querySelector('[data-testid="docked-panel"]')).toBe(initial);
  });

  it("uses moveBefore to relocate the wrapper when the destination supports it", () => {
    renderContainer();

    const wrapper = document
      .querySelector('[data-testid="docked-panel"]')!
      .closest('[data-dock-panel-wrapper="panel-1"]')! as HTMLElement;

    const target = document.createElement("div");
    document.body.appendChild(target);
    const moveBefore = vi.fn(function (this: HTMLElement, node: Node) {
      this.appendChild(node);
    });
    (target as unknown as { moveBefore: typeof moveBefore }).moveBefore = moveBefore;

    act(() => captured!("panel-1", target));

    expect(moveBefore).toHaveBeenCalledTimes(1);
    expect(moveBefore.mock.calls[0]![0]).toBe(wrapper);
    expect(wrapper.parentElement).toBe(target);
  });

  it("falls back to appendChild when moveBefore throws (e.g. disconnected move)", () => {
    renderContainer();

    const wrapper = document
      .querySelector('[data-testid="docked-panel"]')!
      .closest('[data-dock-panel-wrapper="panel-1"]')! as HTMLElement;

    const target = document.createElement("div");
    document.body.appendChild(target);
    (target as unknown as { moveBefore: () => void }).moveBefore = () => {
      throw new Error("HierarchyRequestError");
    };

    act(() => captured!("panel-1", target));

    // Despite the throw, the wrapper still lands in the destination.
    expect(wrapper.parentElement).toBe(target);
  });

  it("is idempotent — re-moving to the current parent does nothing", () => {
    renderContainer();

    const wrapper = document
      .querySelector('[data-testid="docked-panel"]')!
      .closest('[data-dock-panel-wrapper="panel-1"]')! as HTMLElement;

    const target = document.createElement("div");
    document.body.appendChild(target);
    act(() => captured!("panel-1", target));
    expect(wrapper.parentElement).toBe(target);

    const moveBefore = vi.fn();
    (target as unknown as { moveBefore: typeof moveBefore }).moveBefore = moveBefore;
    // Already parented to target — the early return skips any DOM op.
    act(() => captured!("panel-1", target));
    expect(moveBefore).not.toHaveBeenCalled();
    expect(wrapper.parentElement).toBe(target);
  });
});

describe("DockPanelOffscreenContainer drag-handle bridge (#10990)", () => {
  beforeEach(() => {
    closeDockTerminalMock.mockClear();
    setPanels([makePanel({ id: "panel-1" })]);
    capturedRegister = null;
  });

  function renderWithRegister() {
    capturedRegister = null;
    return render(
      <DockPanelOffscreenContainer>
        <CaptureRegister />
      </DockPanelOffscreenContainer>
    );
  }

  it("re-provides the registered handle to the active dock panel's portaled body", () => {
    mockState.activeDockTerminalId = "panel-1";
    renderWithRegister();

    // Before any registration the portaled body sees the empty handle.
    const before = document.querySelector('[data-testid="docked-panel"]')!;
    expect(before.getAttribute("data-has-listeners")).toBe("false");
    expect(before.getAttribute("data-has-activator")).toBe("false");

    const handle = {
      listeners: { onPointerDown: vi.fn(), onKeyDown: vi.fn() },
      setActivatorNodeRef: vi.fn(),
    };
    act(() => {
      capturedRegister!(["panel-1"], handle);
    });

    // The portaled body now receives the live listeners + keyboard activator —
    // grid parity across the createPortal boundary.
    const after = document.querySelector('[data-testid="docked-panel"]')!;
    expect(after.getAttribute("data-has-listeners")).toBe("true");
    expect(after.getAttribute("data-has-activator")).toBe("true");
  });

  it("does NOT provide the handle to a parked (non-active) dock panel", () => {
    mockState.activeDockTerminalId = null; // no popover open
    renderWithRegister();

    const handle = {
      listeners: { onPointerDown: vi.fn() },
      setActivatorNodeRef: vi.fn(),
    };
    act(() => {
      capturedRegister!(["panel-1"], handle);
    });

    // Registered, but gated off because the panel is not the active dock panel:
    // its offscreen header must not become a stray drag/tab target.
    const panel = document.querySelector('[data-testid="docked-panel"]')!;
    expect(panel.getAttribute("data-has-listeners")).toBe("false");
    expect(panel.getAttribute("data-has-activator")).toBe("false");
  });

  it("resolves a group member id to the group's shared handle when that member is active", () => {
    // Two panels; only panel-1 is rendered by this container in the single-panel
    // fixture, so register the group handle under both member ids and make
    // panel-1 active — it must resolve the shared handle.
    mockState.activeDockTerminalId = "panel-1";
    renderWithRegister();

    const groupHandle = {
      listeners: { onPointerDown: vi.fn(), onKeyDown: vi.fn() },
      setActivatorNodeRef: vi.fn(),
    };
    act(() => {
      capturedRegister!(["panel-0", "panel-1"], groupHandle);
    });

    const panel = document.querySelector('[data-testid="docked-panel"]')!;
    expect(panel.getAttribute("data-has-listeners")).toBe("true");
  });

  it("a stale disposer does not clear a newer registration for the same id", () => {
    mockState.activeDockTerminalId = "panel-1";
    renderWithRegister();

    const first = { listeners: { onPointerDown: vi.fn() }, setActivatorNodeRef: vi.fn() };
    const second = { listeners: { onPointerDown: vi.fn() }, setActivatorNodeRef: vi.fn() };

    let disposeFirst!: () => void;
    act(() => {
      disposeFirst = capturedRegister!(["panel-1"], first);
    });
    act(() => {
      capturedRegister!(["panel-1"], second);
    });
    // `second` now owns the id; the first disposer must be a no-op.
    act(() => {
      disposeFirst();
    });

    const panel = document.querySelector('[data-testid="docked-panel"]')!;
    expect(panel.getAttribute("data-has-listeners")).toBe("true");
  });
});
