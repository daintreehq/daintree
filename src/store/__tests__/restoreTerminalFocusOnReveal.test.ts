// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

const focusMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fullWakeForVisibilityRestore: vi.fn(),
    repaintForReveal: vi.fn(),
    revealTerminal: vi.fn(),
    isFocused: vi.fn(() => false),
    setFocused: vi.fn(),
    focus: focusMock,
  },
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));
vi.mock("@/utils/warmReactivationGate", () => ({ notifyWarmReactivationComplete: vi.fn() }));

let mockActiveWorktreeId: string | null = null;
let mockPanelIds: string[] = [];
let mockPanelsById: Record<string, PanelInstance> = {};
let mockFocusedId: string | null = null;

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({ activeWorktreeId: mockActiveWorktreeId }) },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelIds: mockPanelIds,
      panelsById: mockPanelsById,
      focusedId: mockFocusedId,
    }),
  },
}));
vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: () => ({ terminalId: null }) },
  selectSlotTerminalIds: () => [],
}));

const { restoreTerminalFocusOnReveal } = await import("@/store/wakeActiveWorktreeTerminals");

function panel(id: string, overrides: Partial<PanelInstance> = {}): PanelInstance {
  return { id, title: id, kind: "terminal", location: "grid", ...overrides } as PanelInstance;
}

function setGrid(focused: string | null, ids = ["term-a", "term-b"]) {
  mockActiveWorktreeId = "wt-1";
  mockPanelIds = ids;
  mockPanelsById = Object.fromEntries(ids.map((id) => [id, panel(id, { worktreeId: "wt-1" })]));
  mockFocusedId = focused;
}

function mountActive(html: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.querySelector<HTMLElement>("[data-active-target]")!;
  el.focus();
  expect(document.activeElement).toBe(el);
  return el;
}

describe("restoreTerminalFocusOnReveal", () => {
  beforeEach(() => {
    focusMock.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves focus from the switcher pill button to the focused terminal", () => {
    setGrid("term-a");
    mountActive('<button data-active-target class="toolbar-project-pill">pill</button>');
    expect(restoreTerminalFocusOnReveal()).toBe(true);
    expect(focusMock).toHaveBeenCalledWith("term-a");
  });

  it("moves focus from the body to the focused terminal", () => {
    setGrid("term-a");
    document.body.innerHTML = "<div>nothing focused</div>";
    expect(document.activeElement).toBe(document.body);
    expect(restoreTerminalFocusOnReveal()).toBe(true);
    expect(focusMock).toHaveBeenCalledWith("term-a");
  });

  it("leaves a text field, a combobox and editable content alone", () => {
    setGrid("term-a");
    mountActive('<input data-active-target value="typing" />');
    expect(restoreTerminalFocusOnReveal()).toBe(false);
    mountActive('<div data-active-target role="combobox" tabindex="0">search</div>');
    expect(restoreTerminalFocusOnReveal()).toBe(false);
    mountActive('<div data-active-target contenteditable="true" tabindex="0">note</div>');
    expect(restoreTerminalFocusOnReveal()).toBe(false);
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("leaves focus inside an open dialog alone", () => {
    setGrid("term-a");
    mountActive('<div role="dialog"><button data-active-target>ok</button></div>');
    expect(restoreTerminalFocusOnReveal()).toBe(false);
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the focused pane already holds focus", () => {
    setGrid("term-a");
    mountActive(
      '<div data-panel-id="term-a"><textarea data-active-target class="xterm-helper-textarea"></textarea></div>'
    );
    expect(restoreTerminalFocusOnReveal()).toBe(false);
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("does nothing when the focused panel is not in the active worktree's grid", () => {
    setGrid("term-a");
    mockPanelsById["term-a"] = panel("term-a", { worktreeId: "wt-other" });
    mountActive("<button data-active-target>pill</button>");
    expect(restoreTerminalFocusOnReveal()).toBe(false);
    expect(focusMock).not.toHaveBeenCalled();
  });

  it("does nothing without a focused panel", () => {
    setGrid(null);
    mountActive("<button data-active-target>pill</button>");
    expect(restoreTerminalFocusOnReveal()).toBe(false);
  });
});
