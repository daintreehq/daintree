// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { TerminalScratchpad as ScratchpadState } from "@shared/types/panel";

const actions = vi.hoisted(() => ({
  setScratchpadContent: vi.fn(),
  setScratchpadWidth: vi.fn(),
  collapseScratchpad: vi.fn(),
}));

const panelState = {
  panelsById: {} as Record<string, unknown>,
  ...actions,
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: Object.assign(
    (selector: (s: typeof panelState) => unknown) => selector(panelState),
    { getState: () => panelState }
  ),
}));

const flushMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/slices", () => ({ flushPanelPersistence: flushMock }));

const terminalService = vi.hoisted(() => ({
  lockResize: vi.fn(),
  runResizePass: vi.fn(),
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: terminalService,
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalScratchpad } from "../TerminalScratchpad";
import { isScratchpadElement } from "@/lib/terminalScratchpad";

function seed(scratchpad: ScratchpadState | undefined): void {
  panelState.panelsById = {
    "term-1": { id: "term-1", kind: "terminal", title: "Shell", cwd: "/p", scratchpad },
  };
}

function renderPad() {
  return render(
    <TooltipProvider>
      <TerminalScratchpad terminalId="term-1" />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("TerminalScratchpad", () => {
  it("renders nothing until opened, and nothing while collapsed", () => {
    seed(undefined);
    expect(renderPad().container.innerHTML).toBe("");

    seed({ content: "notes", collapsed: true });
    expect(renderPad().container.innerHTML).toBe("");
  });

  it("shows the notes without taking focus", () => {
    seed({ content: "- npm test", collapsed: false });
    const { getByTestId } = renderPad();

    const editor = getByTestId("terminal-scratchpad-editor");
    expect(editor instanceof HTMLTextAreaElement && editor.value).toBe("- npm test");
    expect(document.activeElement).not.toBe(editor);
    expect(isScratchpadElement(editor)).toBe(true);
    expect(isScratchpadElement(editor, "term-1")).toBe(true);
    // Another pane's notes never block a handoff meant for a different pane.
    expect(isScratchpadElement(editor, "term-2")).toBe(false);
    expect(isScratchpadElement(document.body)).toBe(false);
  });

  it("writes each edit to the store and flushes persistence when the editor loses focus", () => {
    seed({ content: "", collapsed: false });
    const { getByTestId } = renderPad();
    const editor = getByTestId("terminal-scratchpad-editor");

    fireEvent.change(editor, { target: { value: "check CI" } });
    expect(actions.setScratchpadContent).toHaveBeenCalledWith("term-1", "check CI");

    fireEvent.blur(editor);
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("keeps one label on the hide control whether or not there are notes", () => {
    seed({ content: "  ", collapsed: false });
    const empty = renderPad();
    const emptyLabel = empty.getByTestId("terminal-scratchpad-collapse").getAttribute("aria-label");
    empty.unmount();

    seed({ content: "note", collapsed: false });
    const { getByTestId } = renderPad();
    const button = getByTestId("terminal-scratchpad-collapse");
    expect(button.getAttribute("aria-label")).toBe(emptyLabel);
    fireEvent.click(button);
    expect(actions.collapseScratchpad).toHaveBeenCalledWith("term-1");
  });

  it("holds the terminal's grid for a drag and commits one width at the end", () => {
    seed({ content: "", collapsed: false, width: 300 });
    const { getByTestId } = renderPad();
    const grip = getByTestId("terminal-scratchpad-resize");

    fireEvent.mouseDown(grip, { button: 0, clientX: 500, detail: 1 });
    act(() => {
      fireEvent.mouseMove(document, { clientX: 460, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 440, buttons: 1 });
    });

    expect(terminalService.lockResize).toHaveBeenCalledWith("term-1", true);
    expect(actions.setScratchpadWidth).not.toHaveBeenCalled();
    // Dragging the left edge leftwards widens the right-hand column.
    expect(getByTestId("terminal-scratchpad").style.width).toBe("360px");

    act(() => {
      fireEvent.mouseUp(document);
    });

    expect(actions.setScratchpadWidth).toHaveBeenCalledTimes(1);
    expect(actions.setScratchpadWidth).toHaveBeenCalledWith("term-1", 360);
    expect(terminalService.lockResize).toHaveBeenLastCalledWith("term-1", false);
    expect(terminalService.runResizePass).toHaveBeenCalledWith(["term-1"]);
  });

  it("treats a click on the grip as a click, not a resize", () => {
    seed({ content: "", collapsed: false, width: 300 });
    const { getByTestId } = renderPad();

    fireEvent.mouseDown(getByTestId("terminal-scratchpad-resize"), {
      button: 0,
      clientX: 500,
      detail: 1,
    });
    act(() => {
      fireEvent.mouseUp(document);
    });

    expect(terminalService.lockResize).not.toHaveBeenCalled();
    expect(actions.setScratchpadWidth).not.toHaveBeenCalled();
  });

  it("resizes from the keyboard with the right-anchored direction", () => {
    seed({ content: "", collapsed: false, width: 300 });
    const { getByTestId } = renderPad();
    const grip = getByTestId("terminal-scratchpad-resize");

    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });

    const [widened, narrowed] = actions.setScratchpadWidth.mock.calls.map((call) => call[1]);
    expect(widened).toBeGreaterThan(300);
    expect(narrowed).toBeLessThan(300);
  });
});
