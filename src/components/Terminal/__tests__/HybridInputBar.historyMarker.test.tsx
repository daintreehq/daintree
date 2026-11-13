// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useCanopyStore } from "@/store/canopyStore";
import { _resetUserPromptTemplateStoreForTest } from "@/store/userPromptTemplateStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { HybridInputBar } from "../HybridInputBar";

// CodeMirror measures text through Range rects, and the palette's scroll
// shadow and motion query reach for ResizeObserver and matchMedia: jsdom has
// none of them.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

const WT_ID = "/repo/wt";
const TERMINAL_ID = "term-1";
const PROJECT_ID = "proj-a";
const SENT = "Rerun the flaky shard and report the failures";

beforeEach(() => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { plugin: {} },
  });
  initBuiltInPanelKinds();
  setCurrentViewStore(createWorktreeStore());
  useTerminalInputStore.setState({ draftInputs: new Map() });
  usePluginRuntimeStore.setState({ promptTemplates: [] });
  _resetUserPromptTemplateStoreForTest();
  useProjectStore.setState({
    currentProject: { id: PROJECT_ID, name: "Alpha", path: "/repo" } as never,
  });
  useCommandHistoryStore.setState({
    history: {
      [hostScopedKey(PROJECT_ID)]: [
        { id: "h1", prompt: SENT, agentId: "claude", addedAt: Date.now() - 60_000 },
      ],
    },
  });
  useCanopyStore.setState({ isOpen: false });
  const panel = {
    id: TERMINAL_ID,
    title: "claude",
    kind: "terminal",
    cwd: WT_ID,
    cols: 120,
    rows: 40,
    worktreeId: WT_ID,
    location: "grid",
    hasPty: true,
    runtimeStatus: "running",
  } as PtyPanelData;
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
    panelIdsByWorktreeId: { [WT_ID]: [panel.id] },
    focusedId: panel.id,
  });
});

afterEach(() => {
  cleanup();
  act(() => usePaletteStore.getState().closePalette("prompt-history"));
  vi.restoreAllMocks();
});

async function renderComposer(props: { disabled?: boolean; onActivate?: () => void } = {}) {
  const { container } = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <HybridInputBar
          terminalId={TERMINAL_ID}
          cwd={WT_ID}
          agentId="claude"
          onSend={vi.fn()}
          {...props}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const content = container.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  const marker = container.querySelector<HTMLElement>("[data-composer-marker]")!;
  return { container, view, marker };
}

const paletteOpen = () => usePaletteStore.getState().activePaletteId === "prompt-history";

/** A real press as the browser orders it: down, up, then the click. */
async function press(el: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0 });
    fireEvent.mouseDown(el, { button: 0 });
    fireEvent.pointerUp(el, { button: 0 });
    fireEvent.mouseUp(el, { button: 0 });
    fireEvent.click(el, { button: 0 });
  });
}

describe("HybridInputBar prompt marker opens prompt history", () => {
  it("is a button named for the action, kept out of the Tab order", async () => {
    const { marker } = await renderComposer();

    const button = screen.getByRole("button", { name: "Search prompt history" });
    expect(button).toBe(marker);
    expect(button.textContent).toBe("❯");
    expect(button.tabIndex).toBe(-1);
    expect(button.closest("[aria-hidden='true']")).toBeNull();
  });

  it("opens the palette Mod+R opens, and a pick fills the composer as it does from there", async () => {
    const { marker, view } = await renderComposer();

    await press(marker);

    expect(paletteOpen()).toBe(true);
    const option = await screen.findByRole("option", { name: new RegExp(SENT) });
    await act(async () => {
      fireEvent.click(option);
    });
    expect(paletteOpen()).toBe(false);
    expect(useTerminalInputStore.getState().getDraftInput(TERMINAL_ID, PROJECT_ID)).toBe(SENT);
    expect(view.state.doc.toString()).toBe(SENT);
  });

  it("leaves the editor as the palette's opener, so closing it returns there", async () => {
    const { marker, view } = await renderComposer();
    view.contentDOM.blur();

    // The press focuses the editor, and the marker itself refuses focus.
    await act(async () => {
      fireEvent.pointerDown(marker, { button: 0 });
    });
    const focusTaken = fireEvent.mouseDown(marker, { button: 0 });
    expect(focusTaken).toBe(false);
    expect(document.activeElement).toBe(view.contentDOM);

    await act(async () => {
      fireEvent.click(marker, { button: 0 });
    });
    expect(paletteOpen()).toBe(true);
  });

  it("opens from an unselected pane, which the press selects", async () => {
    usePanelStore.setState({ focusedId: null });
    const onActivate = vi.fn(() => usePanelStore.setState({ focusedId: TERMINAL_ID }));
    const { marker } = await renderComposer({ onActivate });

    await press(marker);

    expect(onActivate).toHaveBeenCalled();
    expect(paletteOpen()).toBe(true);
  });

  it("opens from an unselected pane on a click with no press before it", async () => {
    usePanelStore.setState({ focusedId: null });
    const onActivate = vi.fn(() => usePanelStore.setState({ focusedId: TERMINAL_ID }));
    const { marker } = await renderComposer({ onActivate });

    await act(async () => {
      fireEvent.click(marker);
    });

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(paletteOpen()).toBe(true);
  });

  it("drops a request the click could not answer, rather than opening on a later focus", async () => {
    usePanelStore.setState({ focusedId: null });
    const { marker } = await renderComposer({ onActivate: () => {} });

    await act(async () => {
      fireEvent.click(marker);
    });
    expect(paletteOpen()).toBe(false);
    // The frame after the click ends the request.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    act(() => usePanelStore.setState({ focusedId: TERMINAL_ID }));
    await act(async () => {});
    expect(paletteOpen()).toBe(false);
  });

  it("stays an inert glyph on a disabled composer", async () => {
    const { marker } = await renderComposer({ disabled: true });

    expect(screen.queryByRole("button", { name: "Search prompt history" })).toBeNull();
    expect(marker.tagName).toBe("SPAN");
    expect(marker.getAttribute("aria-hidden")).toBe("true");
  });

  it("stays an inert glyph on a grid pane while Canopy's composer holds the palette", async () => {
    useCanopyStore.setState({ isOpen: true });
    const { marker } = await renderComposer();

    expect(screen.queryByRole("button", { name: "Search prompt history" })).toBeNull();
    expect(marker.getAttribute("aria-hidden")).toBe("true");
  });
});
