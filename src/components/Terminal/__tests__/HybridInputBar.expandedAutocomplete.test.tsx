// @vitest-environment jsdom
/**
 * Completions typed in the Expanded Editor show in its dialog, where the
 * caret is, instead of in the bar the dialog covers (#16881): rows answer the
 * pointer and the keys there, and Escape closes the menu before the dialog.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";
import { HybridInputBar } from "../HybridInputBar";

const WT_ID = "/repo/wt";
const isMac = /Mac/.test(navigator.platform);
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

// jsdom has no layout: CodeMirror measures text through Range rects it lacks.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: {} },
  });
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  const panel = {
    id: "term-1",
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    detectedAgentId: "claude",
    launchAgentId: "claude",
    agentState: "waiting",
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
  useTerminalInputStore.setState({ draftInputs: new Map(), hybridInputAutoFocus: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalElectron) Object.defineProperty(window, "electron", originalElectron);
  else delete (window as { electron?: unknown }).electron;
  document.body.innerHTML = "";
});

async function mount() {
  const onSend = vi.fn(() => Promise.resolve(true));
  const result = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar terminalId="term-1" cwd={WT_ID} agentId="claude" onSend={onSend} />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const view = EditorView.findFromDOM(result.container.querySelector<HTMLElement>(".cm-editor")!)!;
  view.contentDOM.focus();

  const type = async (text: string) => {
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: "input.type",
      });
    });
  };
  const openExpandedEditor = async () => {
    await act(async () => {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "e", shiftKey: true, metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  };
  /** A real keypress on the editor, so it bubbles to the dialog's own handlers. */
  const press = async (key: string) => {
    await act(async () => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      );
    });
  };
  return { ...result, view, onSend, type, openExpandedEditor, press };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function menuIn(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-autocomplete-menu]");
}

function selectedLabel(menu: HTMLElement): string | null {
  return menu.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? null;
}

describe("HybridInputBar completions in the Expanded Editor", () => {
  it("shows the menu inside the dialog, not in the bar behind it", async () => {
    const { container, view, type, openExpandedEditor } = await mount();
    await openExpandedEditor();
    expect(dialog().contains(view.dom)).toBe(true);

    await type("@");

    const menu = menuIn(dialog());
    expect(menu).not.toBeNull();
    expect(menu!.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    expect(menuIn(container)).toBeNull();
    // The editor still names the list it drives.
    const listbox = menu!.querySelector('[role="listbox"]')!;
    expect(view.contentDOM.getAttribute("aria-controls")).toBe(listbox.id);
  });

  it("moves through the rows with the arrow keys", async () => {
    const { type, openExpandedEditor, press } = await mount();
    await openExpandedEditor();
    await type("@");
    const menu = menuIn(dialog())!;
    const first = selectedLabel(menu);

    await press("ArrowDown");

    expect(selectedLabel(menu)).not.toBeNull();
    expect(selectedLabel(menu)).not.toBe(first);
  });

  it("inserts the row the pointer picks", async () => {
    const { view, type, openExpandedEditor } = await mount();
    await openExpandedEditor();
    await type("@");
    const row = within(dialog())
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") !== "true" && !option.ariaDisabled)!;
    const token = row.querySelector("span")!.textContent!;

    // Apart, as a browser runs them: a press read as outside closes the menu
    // before the click lands.
    await act(async () => {
      fireEvent.pointerDown(row);
    });
    expect(view.contentDOM.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.mouseDown(row);
      fireEvent.click(row);
    });

    expect(view.state.doc.toString().startsWith(token)).toBe(true);
    expect(dialog().contains(view.dom)).toBe(true);
  });

  // jsdom has no layout, so the geometry is given: the token near the top of
  // a 1000 × 500 frame at (100, 200).
  it("places the menu at the token in the dialog's frame", async () => {
    const { view, type, openExpandedEditor } = await mount();
    await openExpandedEditor();
    const frame = view.dom.parentElement!.parentElement!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 200, 1000, 500));
    Object.defineProperty(frame, "clientHeight", { configurable: true, value: 500 });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 150, right: 150, top: 230, bottom: 250 });

    await type("@");

    const menu = menuIn(dialog())!;
    expect(menu.parentElement).toBe(frame);
    expect(menu.style.left).toBe("50px");
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(250 - 200);
    expect(menu.style.bottom).toBe("");
  });

  it("inserts the selected row on Enter without sending", async () => {
    const { view, onSend, type, openExpandedEditor, press } = await mount();
    await openExpandedEditor();
    await type("@dif");

    await press("Enter");

    expect(view.state.doc.toString()).toMatch(/^@diff/);
    expect(onSend).not.toHaveBeenCalled();
    expect(document.querySelector(`[${ESCAPE_BACKSTOP_DIALOG_ATTR}]`)).not.toBeNull();
  });

  it("closes a menu left open in the bar when the editor moves into the dialog", async () => {
    const { container, view, type, openExpandedEditor } = await mount();
    await type("@");
    expect(menuIn(container)).not.toBeNull();

    await openExpandedEditor();

    expect(view.contentDOM.getAttribute("aria-expanded")).not.toBe("true");
    expect(menuIn(dialog())).toBeNull();

    await type(" @");
    expect(menuIn(dialog())).not.toBeNull();
  });

  // The editor is the dialog's last tab stop, where its focus trap wraps Tab
  // round to the first: a Tab the menu took is not one to wrap.
  it("completes on Tab and keeps the caret in the editor", async () => {
    const { view, type, openExpandedEditor, press } = await mount();
    await openExpandedEditor();
    await type("@dif");
    view.contentDOM.focus();

    await press("Tab");

    expect(view.state.doc.toString()).toMatch(/^@diff/);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("keeps the menu open when the editor itself is pressed", async () => {
    const { view, type, openExpandedEditor } = await mount();
    await openExpandedEditor();
    await type("@");

    await act(async () => {
      fireEvent.pointerDown(view.contentDOM);
    });

    expect(menuIn(dialog())?.querySelector('[role="listbox"]')).not.toBeNull();
    expect(view.contentDOM.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes the menu on the first Escape and the dialog on the next", async () => {
    const { view, type, openExpandedEditor, press } = await mount();
    await openExpandedEditor();
    await type("@");
    expect(view.contentDOM.getAttribute("aria-expanded")).toBe("true");

    await press("Escape");

    expect(view.contentDOM.getAttribute("aria-expanded")).not.toBe("true");
    expect(document.querySelector(`[${ESCAPE_BACKSTOP_DIALOG_ATTR}]`)).not.toBeNull();
    expect(dialog().contains(view.dom)).toBe(true);

    await press("Escape");

    expect(document.querySelector(`[${ESCAPE_BACKSTOP_DIALOG_ATTR}]`)).toBeNull();
  });
});
