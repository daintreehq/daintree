// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { PtyPanelData } from "@shared/types/panel";
import type { Project } from "@shared/types/project";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { GLOBAL_ASSISTANT_HISTORY_ID, useCommandHistoryStore } from "@/store/commandHistoryStore";
import { usePromptHistoryOwnerStore } from "@/store/promptHistoryOwnerStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useCanopyStore } from "@/store/canopyStore";
import { _resetUserPromptTemplateStoreForTest } from "@/store/userPromptTemplateStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { hostScopedKey } from "@/hooks/useHostPlatform";
import { isolatedComposerScope } from "@/lib/draftKey";
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
  const project: Project = {
    id: PROJECT_ID,
    name: "Alpha",
    path: "/repo",
    emoji: "🌲",
    lastOpened: 0,
  };
  useProjectStore.setState({ currentProject: project });
  const sent = [{ id: "h1", prompt: SENT, agentId: "claude", addedAt: Date.now() - 60_000 }];
  useCommandHistoryStore.setState({ history: { [hostScopedKey(PROJECT_ID)]: sent } });
  usePromptHistoryOwnerStore.setState({ owner: null });
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

async function renderComposer(
  props: {
    disabled?: boolean;
    onActivate?: () => void;
    isolated?: boolean;
    otherHostId?: string;
  } = {}
) {
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
const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });

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

  it("keeps focus off the marker itself, so the press leaves it with the editor", async () => {
    const { marker, view } = await renderComposer();
    view.contentDOM.blur();

    await act(async () => {
      fireEvent.pointerDown(marker, { button: 0 });
    });
    const focusTaken = fireEvent.mouseDown(marker, { button: 0 });
    expect(focusTaken).toBe(false);
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("hands focus to the palette's search, and back to the editor when it closes", async () => {
    const { marker, view } = await renderComposer();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    try {
      // A click with no press first, so nothing but the marker's own handler
      // can have put the editor under the palette as its opener.
      await act(async () => {
        fireEvent.click(marker);
      });
      expect(paletteOpen()).toBe(true);
      const search = screen.getByRole("combobox", { name: "Search prompt history" });
      await waitFor(() => expect(document.activeElement).toBe(search));

      await act(async () => {
        fireEvent.keyDown(search, { key: "Escape" });
      });
      expect(paletteOpen()).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    } finally {
      elsewhere.remove();
    }
  });

  it("opens from an unselected pane, which the press selects", async () => {
    usePanelStore.setState({ focusedId: null });
    const onActivate = vi.fn(() => usePanelStore.setState({ focusedId: TERMINAL_ID }));
    const { marker } = await renderComposer({ onActivate });
    expect(onActivate).not.toHaveBeenCalled();

    // The press alone selects the pane and mounts its palette, before any click.
    await act(async () => {
      fireEvent.pointerDown(marker, { button: 0 });
      fireEvent.mouseDown(marker, { button: 0 });
    });
    expect(onActivate).toHaveBeenCalled();
    expect(usePanelStore.getState().focusedId).toBe(TERMINAL_ID);
    expect(paletteOpen()).toBe(false);
    const activations = onActivate.mock.calls.length;

    await act(async () => {
      fireEvent.pointerUp(marker, { button: 0 });
      fireEvent.mouseUp(marker, { button: 0 });
      fireEvent.click(marker, { button: 0 });
    });
    expect(paletteOpen()).toBe(true);
    // The palette was already there to open: the click asked for no selection.
    expect(onActivate).toHaveBeenCalledTimes(activations);
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
    await nextFrame();

    act(() => usePanelStore.setState({ focusedId: TERMINAL_ID }));
    await act(async () => {});
    expect(paletteOpen()).toBe(false);
  });

  it("stays an inert glyph on a disabled composer", async () => {
    const { marker } = await renderComposer({ disabled: true });

    expect(screen.queryByRole("button", { name: "Search prompt history" })).toBeNull();
    expect(marker.tagName).toBe("SPAN");
    expect(marker.getAttribute("aria-hidden")).toBe("true");
    // The same glyph-wide box as the clickable marker, with nothing that sizes it.
    expect(
      marker.className
        .split(/\s+/)
        .filter((c) => /^(min-|max-)?w-|^size-|^p[xlr]?-|^(hover|focus|focus-visible):/.test(c))
    ).toEqual([]);
  });

  it("stays an inert glyph on a grid pane while Canopy's composer holds the palette", async () => {
    useCanopyStore.setState({ isOpen: true });
    const { marker } = await renderComposer();

    expect(screen.queryByRole("button", { name: "Search prompt history" })).toBeNull();
    expect(marker.getAttribute("aria-hidden")).toBe("true");
  });
  it("stays an inert glyph on a composer typing to another host", async () => {
    const { marker } = await renderComposer({ isolated: true, otherHostId: "studio" });

    expect(screen.queryByRole("button", { name: "Search prompt history" })).toBeNull();
    expect(marker.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      fireEvent.click(marker);
    });
    expect(paletteOpen()).toBe(false);
  });

  it("opens history from this machine's isolated composer, Canopy open or not", async () => {
    useCanopyStore.setState({ isOpen: true });
    usePanelStore.setState({ focusedId: null });
    const { marker } = await renderComposer({ isolated: true });

    await press(marker);

    expect(paletteOpen()).toBe(true);
  });

  it("names the action and its chord in a tooltip on hover", async () => {
    const { marker } = await renderComposer();

    await act(async () => {
      fireEvent.pointerMove(marker, { pointerType: "mouse" });
    });
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: 3000 });
    expect(tooltip.textContent).toContain("Search prompt history");
    // The chord as spoken: the platform's primary modifier and R, nothing else.
    const spoken = Array.from(tooltip.querySelectorAll(".sr-only")).map((el) => el.textContent);
    expect(spoken).toContainEqual(expect.stringMatching(/^(Command|Ctrl) R$/));
  });
});

const OTHER_PROJECT_ID = "proj-b";
const OTHER_SENT = "Bump the lockfile and push";
const GLOBAL_ID = "global-1";

type ComposerProps = Partial<React.ComponentProps<typeof HybridInputBar>>;

/**
 * A grid pane's composer beside one outside the grid, each where it lives: the
 * pane's in its pane, the other in a host of its own.
 */
async function renderBeside(offGrid: ComposerProps & { terminalId: string }) {
  const { container } = render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={createWorktreeStore()}>
        <div data-panel-id={TERMINAL_ID} data-testid="pane">
          <HybridInputBar terminalId={TERMINAL_ID} cwd={WT_ID} agentId="claude" onSend={vi.fn()} />
        </div>
        <section data-prompt-history-host="" data-testid="host">
          <HybridInputBar cwd="" agentId="claude" onSend={vi.fn()} {...offGrid} />
        </section>
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  await act(async () => {});
  const viewIn = (testId: string) =>
    EditorView.findFromDOM(
      container.querySelector<HTMLElement>(`[data-testid="${testId}"] .cm-content`)!
    )!;
  const pane = viewIn("pane");
  const other = viewIn("host");
  // Start from the grid, wherever mounting left focus.
  act(() => pane.contentDOM.focus());
  return { pane, other };
}

/** The `:` route in the Action Palette: it opens whichever palette is mounted. */
async function openFromActionPalette() {
  const actionSearch = document.createElement("input");
  document.body.appendChild(actionSearch);
  act(() => actionSearch.focus());
  actionSearch.remove();
  await act(async () => {
    usePaletteStore.getState().openPalette("prompt-history");
  });
}

async function recall(prompt: string) {
  const option = await screen.findByRole("option", { name: new RegExp(prompt) });
  await act(async () => {
    fireEvent.click(option);
  });
}

const mountedPalettes = () => screen.queryAllByRole("combobox", { name: "Search prompt history" });

describe("HybridInputBar prompt history has one composer at a time", () => {
  it("serves the grid pane until focus lands in the global assistant, then it alone", async () => {
    const { other } = await renderBeside({
      isolated: true,
      terminalId: GLOBAL_ID,
      historyProjectId: GLOBAL_ASSISTANT_HISTORY_ID,
    });

    await openFromActionPalette();
    expect(mountedPalettes()).toHaveLength(1);
    await recall(SENT);
    expect(useTerminalInputStore.getState().getDraftInput(TERMINAL_ID, PROJECT_ID)).toBe(SENT);

    act(() => other.contentDOM.focus());
    await openFromActionPalette();
    expect(mountedPalettes()).toHaveLength(1);
    await recall(SENT);
    // Into the assistant's own draft, which stays apart from every project's.
    expect(useTerminalInputStore.getState().getDraftInput(GLOBAL_ID, isolatedComposerScope())).toBe(
      SENT
    );
    expect(other.state.doc.toString()).toBe(SENT);
  });

  it("opens the Project Assistant's history by Mod+R and `:`, never the pane's behind it", async () => {
    const isMac = /Mac/.test(navigator.platform);
    const { pane, other } = await renderBeside({
      terminalId: "assistant-1",
      ownsHistoryByFocus: true,
    });

    act(() => other.contentDOM.focus());
    await act(async () => {
      runScopeHandlers(
        other,
        new KeyboardEvent("keydown", { key: "r", metaKey: isMac, ctrlKey: !isMac }),
        "editor"
      );
    });
    expect(paletteOpen()).toBe(true);
    expect(mountedPalettes()).toHaveLength(1);
    await recall(SENT);
    expect(useTerminalInputStore.getState().getDraftInput("assistant-1", PROJECT_ID)).toBe(SENT);
    expect(pane.state.doc.toString()).toBe("");

    await openFromActionPalette();
    expect(mountedPalettes()).toHaveLength(1);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Search prompt history" }), {
        key: "Escape",
      });
    });

    // The palette hands focus back to the composer it opened over.
    await waitFor(() => expect(document.activeElement).toBe(other.contentDOM));

    // Back in the grid, the pane's composer holds history again.
    act(() => pane.contentDOM.focus());
    await openFromActionPalette();
    await recall(SENT);
    expect(useTerminalInputStore.getState().getDraftInput(TERMINAL_ID, PROJECT_ID)).toBe(SENT);
  });

  it("opens the Project Assistant's history from its marker before focus ever reached it", async () => {
    await renderBeside({ terminalId: "assistant-1", ownsHistoryByFocus: true });
    const markers = document.querySelectorAll<HTMLElement>("[data-composer-marker]");

    await act(async () => {
      fireEvent.click(markers[1]!);
    });

    expect(paletteOpen()).toBe(true);
    expect(mountedPalettes()).toHaveLength(1);
    await recall(SENT);
    expect(useTerminalInputStore.getState().getDraftInput("assistant-1", PROJECT_ID)).toBe(SENT);
  });

  it("offers nothing to a composer outside the grid while it is off screen", async () => {
    const { other } = await renderBeside({ terminalId: "assistant-1", ownsHistoryByFocus: false });

    act(() => other.contentDOM.focus());
    await openFromActionPalette();
    await recall(SENT);

    // Not by focus: the grid's focused pane keeps it.
    expect(useTerminalInputStore.getState().getDraftInput(TERMINAL_ID, PROJECT_ID)).toBe(SENT);
  });

  it("reads and keeps Canopy's reply history under the run's project, its draft its own", async () => {
    useCommandHistoryStore.setState({
      history: {
        [hostScopedKey(PROJECT_ID)]: [
          { id: "h1", prompt: SENT, agentId: "claude", addedAt: Date.now() - 60_000 },
        ],
        [hostScopedKey(OTHER_PROJECT_ID)]: [
          { id: "h2", prompt: OTHER_SENT, agentId: "claude", addedAt: Date.now() - 30_000 },
        ],
      },
    });
    const submitText = vi.fn(async () => true);
    const { other } = await renderBeside({
      isolated: true,
      terminalId: "run-1",
      historyProjectId: OTHER_PROJECT_ID,
      submitText,
    });

    act(() => other.contentDOM.focus());
    await openFromActionPalette();
    // This project is the run's, not the window's.
    await screen.findByRole("option", { name: new RegExp(OTHER_SENT) });
    expect(screen.queryByRole("option", { name: new RegExp(SENT) })).toBeNull();
    await recall(OTHER_SENT);
    expect(useTerminalInputStore.getState().getDraftInput("run-1", isolatedComposerScope())).toBe(
      OTHER_SENT
    );
    expect(useTerminalInputStore.getState().getDraftInput("run-1", OTHER_PROJECT_ID)).toBe("");

    await act(async () => {
      other.dispatch({ changes: { from: 0, insert: "Rebase onto develop " } });
    });
    await act(async () => {
      runScopeHandlers(other, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });
    expect(submitText).toHaveBeenCalledTimes(1);
    const kept = useCommandHistoryStore.getState().history;
    expect(kept[hostScopedKey(OTHER_PROJECT_ID)]?.[0]?.prompt).toBe(
      `Rebase onto develop ${OTHER_SENT}`
    );
    expect(kept[hostScopedKey(isolatedComposerScope())]).toBeUndefined();
  });

  it("keeps no history for a reply on another host", async () => {
    const submitText = vi.fn(async () => true);
    const { other } = await renderBeside({
      isolated: true,
      otherHostId: "studio",
      terminalId: "run-2",
      historyProjectId: OTHER_PROJECT_ID,
      submitText,
    });
    const before = useCommandHistoryStore.getState().history;

    act(() => other.contentDOM.focus());
    await act(async () => {
      other.dispatch({ changes: { from: 0, insert: "Check the build" } });
    });
    await act(async () => {
      runScopeHandlers(other, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    });

    expect(submitText).toHaveBeenCalledTimes(1);
    expect(useCommandHistoryStore.getState().history).toEqual(before);
  });
});
