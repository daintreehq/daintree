// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { undo } from "@codemirror/commands";
import type { PtyPanelData } from "@shared/types/panel";

const commandsClientMock = vi.hoisted(() => ({
  list: vi.fn(),
  getBuilder: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/clients/commandsClient", () => ({ commandsClient: commandsClientMock }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useCommandStore } from "@/store/commandStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { HybridInputBar } from "../HybridInputBar";

// CodeMirror measures text through Range rects on an animation frame, which
// can land after a test ends; jsdom has neither method.
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

// A template is added to what the user has written, never put in its place
// (#14956), and never sent (#13799). These drive the real picker into the real
// composer, so the route is the one a click takes.
describe("HybridInputBar prompt templates", () => {
  const WT_ID = "/repo/wt";
  const TERMINAL_ID = "term-1";

  const entry = (
    body: string,
    args: { name: string; label: string; required?: boolean }[] = []
  ) => ({
    key: "acme::boilerplate",
    pluginId: "acme",
    pluginName: "Acme CRM",
    projectId: null,
    template: {
      id: "boilerplate",
      title: "Add boilerplate",
      description: "Standard closing instructions.",
      body,
      args,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: {} },
    });
    commandsClientMock.list.mockResolvedValue([]);
    initBuiltInPanelKinds();
    setCurrentViewStore(createWorktreeStore());
    useTerminalInputStore.setState({ draftInputs: new Map() });
    useCommandStore.setState({ isPickerOpen: false, pickerOwnerId: null, activeCommand: null });
    const panel = {
      id: TERMINAL_ID,
      title: "terminal",
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
    vi.restoreAllMocks();
  });

  async function renderComposer(draft: string, template: ReturnType<typeof entry>) {
    usePluginRuntimeStore.setState({ promptTemplates: [template] });
    const onSend = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <WorktreeStoreContext.Provider value={createWorktreeStore()}>
          <HybridInputBar terminalId={TERMINAL_ID} cwd={WT_ID} onSend={onSend} />
        </WorktreeStoreContext.Provider>
      </TooltipProvider>
    );
    await act(async () => {});
    const content = container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    if (draft) {
      act(() => {
        view.dispatch({ changes: { from: 0, insert: draft } });
      });
    }
    return { onSend, view };
  }

  async function pickTemplate() {
    fireEvent.click(screen.getByRole("button", { name: "Open command picker" }));
    fireEvent.click(await screen.findByRole("option", { name: /Add boilerplate/ }));
    await act(async () => {});
  }

  const storedDraft = () => useTerminalInputStore.getState().getDraftInput(TERMINAL_ID);

  it("fills an empty draft with the template and leaves the caret after it", async () => {
    const { view, onSend } = await renderComposer("", entry("Run the tests."));

    await pickTemplate();

    expect(view.state.doc.toString()).toBe("Run the tests.");
    expect(view.state.selection.main.head).toBe("Run the tests.".length);
    expect(storedDraft()).toBe("Run the tests.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("adds the template after what is already written, a blank line apart", async () => {
    const { view, onSend } = await renderComposer("Fix the retry loop.", entry("Run the tests."));

    await pickTemplate();

    const expected = "Fix the retry loop.\n\nRun the tests.";
    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(expected.length);
    expect(storedDraft()).toBe(expected);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("adds only the newlines the draft is missing", async () => {
    const { view } = await renderComposer("Fix the retry loop.\n", entry("Run the tests."));

    await pickTemplate();

    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.");
  });

  it("keeps the words in place whatever the caret or selection was", async () => {
    const { view } = await renderComposer("Fix the retry loop.", entry("Run the tests."));
    act(() => {
      view.dispatch({ selection: EditorSelection.range(4, 9) });
    });

    await pickTemplate();

    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.");
  });

  it("replaces a draft that is only whitespace", async () => {
    const { view } = await renderComposer("  \n", entry("Run the tests."));

    await pickTemplate();

    expect(view.state.doc.toString()).toBe("Run the tests.");
    expect(storedDraft()).toBe("Run the tests.");
  });

  it("makes the template an undo step of its own, apart from the draft and from typing after it", async () => {
    const { view } = await renderComposer("Fix the retry loop.", entry("Run the tests."));

    await pickTemplate();
    act(() => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "!" },
        userEvent: "input.type",
      });
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.!");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.\n\nRun the tests.");

    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    expect(storedDraft()).toBe("Fix the retry loop.");
  });

  it("lands a template written with CRLF breaks, with the caret after it", async () => {
    const { view } = await renderComposer("Fix the retry loop.", entry("Run:\r\n- tests\r- lint"));

    await pickTemplate();

    const expected = "Fix the retry loop.\n\nRun:\n- tests\n- lint";
    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(expected.length);
  });

  it("leaves a written draft as it is when the template renders to nothing", async () => {
    const { view } = await renderComposer(
      "Fix the retry loop.",
      entry("{{extra}}", [{ name: "extra", label: "Extra" }])
    );

    await pickTemplate();
    fireEvent.click(await screen.findByRole("button", { name: "Fill draft" }));
    await act(async () => {});

    expect(view.state.doc.toString()).toBe("Fix the retry loop.");
    expect(storedDraft()).toBe("Fix the retry loop.");
  });

  it("adds a template that asked for arguments to the draft as it is when the form is filled", async () => {
    const { view, onSend } = await renderComposer(
      "Fix the retry loop.",
      entry("Tell {{who}} when done.", [{ name: "who", label: "Who", required: true }])
    );

    await pickTemplate();
    fireEvent.change(await screen.findByLabelText("Who"), { target: { value: "Ada" } });
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: " Keep the API." } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
    await act(async () => {});

    expect(view.state.doc.toString()).toBe(
      "Fix the retry loop. Keep the API.\n\nTell Ada when done."
    );
    expect(onSend).not.toHaveBeenCalled();
  });
});
