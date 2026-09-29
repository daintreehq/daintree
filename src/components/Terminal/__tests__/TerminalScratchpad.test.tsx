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
import {
  SCRATCHPAD_COUNT_THRESHOLD,
  SCRATCHPAD_MAX_CHARS,
  isScratchpadElement,
} from "@/lib/terminalScratchpad";

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

  it("names the editor from its title bar and describes it from the status bar", () => {
    seed({ content: "", collapsed: false });
    const { getByTestId } = renderPad();
    const editor = getByTestId("terminal-scratchpad-editor");
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error("editor is not a textarea");

    // A placeholder is not a name: the label must be a real element tied to the editor.
    const label = editor.labels?.[0];
    expect(label?.textContent?.trim()).toBeTruthy();
    expect(label?.textContent).not.toBe(editor.placeholder);

    const describedBy = editor.getAttribute("aria-describedby");
    const description = describedBy ? document.getElementById(describedBy) : null;
    expect(description?.textContent?.trim()).toBeTruthy();
    expect(getByTestId("terminal-scratchpad-status").contains(description)).toBe(true);
  });

  it("draws the editor as the column's body, not a boxed field with its own ring", () => {
    seed({ content: "notes", collapsed: false });
    const { getByTestId } = renderPad();
    const classes = getByTestId("terminal-scratchpad-editor").className.split(/\s+/);

    expect(classes.some((c) => /^rounded/.test(c))).toBe(false);
    expect(classes.some((c) => /^focus(-visible)?:outline-(?!hidden)/.test(c))).toBe(false);
    expect(classes.some((c) => /^border(-|$)/.test(c) && c !== "border-0")).toBe(false);
  });

  it("counts characters only once the notes near the limit", () => {
    seed({ content: "x".repeat(SCRATCHPAD_COUNT_THRESHOLD - 1), collapsed: false });
    const below = renderPad();
    expect(below.queryByTestId("terminal-scratchpad-count")).toBeNull();
    below.unmount();

    seed({ content: "x".repeat(SCRATCHPAD_COUNT_THRESHOLD), collapsed: false });
    const { getByTestId } = renderPad();
    const count = getByTestId("terminal-scratchpad-count").textContent ?? "";
    expect(count).toContain(SCRATCHPAD_COUNT_THRESHOLD.toLocaleString());
    expect(count).toContain(SCRATCHPAD_MAX_CHARS.toLocaleString());
  });
  it("announces the width on screen and the range a drag can reach under the half-pane cap", () => {
    type Notify = (entries: Array<{ contentRect: { width: number } }>) => void;
    let notify: Notify = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: Notify) {
          notify = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    try {
      seed({ content: "", collapsed: false, width: 400 });
      const { getByTestId } = render(
        <TooltipProvider>
          <div>
            <TerminalScratchpad terminalId="term-1" />
          </div>
        </TooltipProvider>
      );
      const paneWidth = 500;
      act(() => notify([{ contentRect: { width: paneWidth } }]));

      const grip = getByTestId("terminal-scratchpad-resize");
      const now = Number(grip.getAttribute("aria-valuenow"));
      const max = Number(grip.getAttribute("aria-valuemax"));
      const min = Number(grip.getAttribute("aria-valuemin"));
      expect(max).toBeLessThanOrEqual(paneWidth / 2);
      expect(now).toBeLessThanOrEqual(max);
      expect(min).toBeLessThanOrEqual(max);
      expect(grip.getAttribute("aria-valuetext")).toContain(String(now));
      // The separator resizes the whole column, not just the editor inside it.
      expect(grip.getAttribute("aria-controls")).toBe(getByTestId("terminal-scratchpad").id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets a keyboard user reach the lifecycle explanation the status bar abbreviates", () => {
    seed({ content: "", collapsed: false });
    const { getByTestId } = renderPad();
    const status = getByTestId("terminal-scratchpad-status");
    const editor = getByTestId("terminal-scratchpad-editor");
    const description = document.getElementById(editor.getAttribute("aria-describedby") ?? "");

    const trigger = description?.closest("[tabindex]");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("tabindex")).toBe("0");
    expect(status.contains(trigger ?? null)).toBe(true);
  });
});
