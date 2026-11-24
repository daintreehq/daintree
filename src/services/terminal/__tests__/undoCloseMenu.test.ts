/**
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import type { UndoCloseMenuState } from "@shared/types/menu";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

vi.mock("@/services/agentResumeForPerson", () => ({ resumeSessionForPerson: vi.fn() }));

const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { usePreferencesStore } = await import("@/store/preferencesStore");
const { setCurrentProjectIdAccessor, setWorktreeIdSetAccessor } =
  await import("@/store/storeAccessors");
const { keybindingService } = await import("@/services/KeybindingService");
const history = await import("../panelCloseHistory");
const { trackNativeFieldEdits, resetCloseUndoOrderForTests } = await import("../closeUndoOrder");
const { undoCloseMenuState, startUndoCloseMenuPublisher } = await import("../undoCloseMenu");
const { undoCloseTakesKey } = await import("../undoCloseKey");
const { PLUGIN_STYLE_OWNER_ATTRIBUTE } = await import("@/services/plugin/pluginStyleOwner");
const { registerPanelCoreActions } =
  await import("@/services/actions/definitions/panelCoreActions");
const { EditorState, Transaction } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
const { buildMarkdownEditorExtensions } =
  await import("../../../../plugins/builtin/markdown-editor/renderer/markdownEditorExtensions");

function seed(id: string, extra: Partial<PtyPanelData> = {}) {
  const panel: PtyPanelData = {
    id,
    title: id,
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    isVisible: true,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    ...extra,
  };
  usePanelStore.setState((state) => ({
    panelsById: { ...state.panelsById, [id]: panel },
    panelIds: state.panelIds.includes(id) ? state.panelIds : [...state.panelIds, id],
  }));
}

function userClose(ids: string[]) {
  history.prepareUserClose(ids)(() => ids.forEach((id) => usePanelStore.getState().trashPanel(id)));
}

function locationOf(id: string) {
  return usePanelStore.getState().panelsById[id]?.location;
}

function focusNew<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  setup?: (element: HTMLElementTagNameMap[K]) => void
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  setup?.(element);
  document.body.appendChild(element);
  element.focus();
  return element;
}

function typeInto(field: HTMLInputElement, value: string) {
  field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

// The Markdown editor's own buffer, as a File or File Browser panel mounts it.
function focusMarkdownEditor(doc: string): InstanceType<typeof EditorView> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: buildMarkdownEditorExtensions({
        language: markdown({ base: markdownLanguage }),
        polarity: "dark",
        wrapLines: false,
        ariaLabel: "plan.md",
        callbacks: { onChange: () => {}, onSave: () => {}, onFollowLink: () => {} },
      }),
    }),
  });
  view.focus();
  return view;
}

// Stamped with `time`, so typing a moment apart stays inside the delay that
// merges it into one undo step however long the run pauses between.
function typeInEditor(view: InstanceType<typeof EditorView>, text: string, time: number) {
  const at = view.state.doc.length;
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: "input.type",
    annotations: Transaction.time.of(time),
  });
}

function undoCloseAction() {
  const actions = new Map();
  registerPanelCoreActions(actions, {} as never);
  return actions.get("panel.undoClose")!();
}

beforeEach(async () => {
  await usePanelStore.getState().reset();
  history.resetPanelCloseHistoryForTests();
  history.connectPanelCloseHistory(usePanelStore);
  resetCloseUndoOrderForTests();
  setCurrentProjectIdAccessor(() => "proj-1");
  setWorktreeIdSetAccessor(() => null);
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
  keybindingService.applyOverrides({});
});

afterEach(() => {
  history.connectPanelCloseHistory(null);
  keybindingService.applyOverrides({});
  document.body.replaceChildren();
});

describe("what Edit > Undo names", () => {
  it("reads Undo with nothing to reopen", () => {
    expect(undoCloseMenuState()).toBeNull();
  });

  it("names one panel by the title its header showed, and a batch by its count", () => {
    const agent: Partial<PtyPanelData> = {
      title: "Claude",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "working",
      lastObservedTitle: "fix tests",
    };
    seed("a", agent);
    seed("a2", agent);
    usePreferencesStore.setState({ showAgentTaskTitles: false });
    userClose(["a2"]);
    expect(undoCloseMenuState()).toEqual({ count: 1, title: "Claude" });

    usePreferencesStore.setState({ showAgentTaskTitles: true });
    userClose(["a"]);
    expect(undoCloseMenuState()).toEqual({ count: 1, title: "Claude: fix tests" });

    seed("b");
    seed("c");
    seed("d");
    userClose(["b", "c", "d"]);
    expect(undoCloseMenuState()).toEqual({ count: 3, title: null });
  });

  it("keeps an agent's title once the trash has let the panel go", () => {
    seed("agent", {
      title: "Codex",
      launchAgentId: "codex",
      detectedAgentId: "codex",
      agentState: "idle",
    });
    userClose(["agent"]);
    usePanelStore.getState().removePanel("agent");
    expect(usePanelStore.getState().panelsById.agent).toBeUndefined();
    expect(history.peekUndoCloseStep()?.panels[0]?.status).toBe("expired");
    expect(undoCloseMenuState()).toEqual({ count: 1, title: "Codex" });
  });

  it("names a file, a diff and a browser the way their headers do", () => {
    const named = (panel: Record<string, unknown>) =>
      history.closedPanelTitle({
        id: "p",
        location: "grid",
        isVisible: true,
        worktreeId: "wt-1",
        ...panel,
      } as never);
    expect(named({ kind: "file", title: "File", filePath: "/repo/docs/spec.md" })).toBe("spec.md");
    expect(
      named({ kind: "file", title: "Notes", titleMode: "user", filePath: "/repo/spec.md" })
    ).toBe("Notes");
    expect(named({ kind: "diff", title: "Diff", filePath: "C:\\repo\\src\\a.ts" })).toBe("a.ts");
    expect(
      named({ kind: "browser", title: "Browser", browserUrl: "http://localhost:5173/x" })
    ).toBe("localhost:5173");
    expect(named({ kind: "browser", title: "Docs", browserUrl: "http://localhost:5173/" })).toBe(
      "Docs"
    );
    expect(named({ kind: "browser", title: "Browser", browserUrl: "not a url" })).toBe("Browser");
  });

  it("publishes no more of a title than main takes", () => {
    seed("long", { title: "x".repeat(10_000) });
    userClose(["long"]);
    const title = undoCloseMenuState()?.title ?? "";
    expect(title.length).toBeGreaterThan(40);
    expect(title.length).toBeLessThanOrEqual(4096);
  });

  it("counts only the panels of a batch still in the trash", () => {
    for (const id of ["a", "b", "c"]) seed(id);
    userClose(["a", "b", "c"]);
    usePanelStore.getState().restoreTerminal("b");
    expect(undoCloseMenuState()).toEqual({ count: 2, title: null });
  });

  it("gives Cmd+Z to a field typed in since the close, and the close to one typed in before it", () => {
    trackNativeFieldEdits();
    const field = focusNew("input");
    typeInto(field, "older");
    seed("a");
    userClose(["a"]);
    expect(undoCloseMenuState()).toEqual({ count: 1, title: "a" });

    typeInto(field, "older newer");
    expect(undoCloseMenuState()).toBeNull();
  });

  it("names the close from a terminal", () => {
    seed("a");
    userClose(["a"]);
    focusNew("div", (host) => {
      host.className = "xterm";
      host.tabIndex = 0;
    });
    expect(undoCloseMenuState()).toEqual({ count: 1, title: "a" });
  });

  it("reads Undo where Cmd+Z never reaches the close", () => {
    seed("a");
    userClose(["a"]);

    focusNew("div", (host) => {
      host.setAttribute(PLUGIN_STYLE_OWNER_ATTRIBUTE, "acme");
      host.tabIndex = 0;
    });
    expect(undoCloseMenuState()).toBeNull();

    focusNew("div", (host) => {
      host.setAttribute("data-keybindings-isolated", "");
      host.tabIndex = 0;
    });
    expect(undoCloseMenuState()).toBeNull();

    focusNew("iframe");
    expect(undoCloseMenuState()).toBeNull();
  });

  it("reads Undo once Cmd+Z runs something else", () => {
    seed("a");
    userClose(["a"]);
    expect(undoCloseMenuState()).not.toBeNull();

    keybindingService.applyOverrides({ "panel.undoClose": ["Cmd+Alt+U"] });
    expect(undoCloseMenuState()).toBeNull();

    keybindingService.applyOverrides({ "nav.toggleSidebar": ["Cmd+Z"] });
    expect(undoCloseMenuState()).toBeNull();

    keybindingService.applyOverrides({});
    expect(undoCloseMenuState()).not.toBeNull();
  });

  it("asks without touching a pending chord", () => {
    seed("a");
    userClose(["a"]);
    keybindingService.resolveKeybinding(
      new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true })
    );
    const pending = keybindingService.getPendingChord();
    expect(pending).not.toBeNull();
    const chord = vi.fn();
    const unsubscribe = keybindingService.subscribeChord(chord);
    // A pending chord takes Cmd+Z as its next key, which nothing completes.
    expect(undoCloseMenuState()).toBeNull();
    unsubscribe();
    expect(chord).not.toHaveBeenCalled();
    expect(keybindingService.getPendingChord()).toBe(pending);
    expect(keybindingService.getLastInvalidKey()).toBeNull();
    keybindingService.clearPendingChord();
  });
});

describe("the publisher", () => {
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("publishes as it starts, then each change once", async () => {
    const published: UndoCloseMenuState[] = [];
    const stop = startUndoCloseMenuPublisher((state) => published.push(state));
    await settle();
    expect(published).toEqual([null]);

    seed("a");
    seed("b");
    userClose(["a"]);
    userClose(["b"]);
    await settle();
    expect(published).toEqual([null, { count: 1, title: "b" }]);

    // Focus settling on an element that changes nothing publishes nothing.
    focusNew("button");
    await settle();
    expect(published).toHaveLength(2);

    usePanelStore.getState().restoreTerminal("b");
    await settle();
    expect(published.at(-1)).toEqual({ count: 1, title: "a" });

    stop();
    usePanelStore.getState().restoreTerminal("a");
    await settle();
    expect(published.at(-1)).toEqual({ count: 1, title: "a" });
  });

  it("follows typing in the focused field and a key rebound", async () => {
    trackNativeFieldEdits();
    const published: UndoCloseMenuState[] = [];
    const stop = startUndoCloseMenuPublisher((state) => published.push(state));
    seed("a");
    userClose(["a"]);
    const field = focusNew("input");
    await settle();
    expect(published.at(-1)).toEqual({ count: 1, title: "a" });

    typeInto(field, "since the close");
    await settle();
    expect(published.at(-1)).toBeNull();

    field.blur();
    await settle();
    expect(published.at(-1)).toEqual({ count: 1, title: "a" });

    keybindingService.applyOverrides({ "panel.undoClose": [] });
    await settle();
    expect(published.at(-1)).toBeNull();
    stop();
  });

  it("looks again when the window's focus goes into a frame", async () => {
    const published: UndoCloseMenuState[] = [];
    const stop = startUndoCloseMenuPublisher((state) => published.push(state));
    seed("a");
    userClose(["a"]);
    await settle();
    expect(published.at(-1)).toEqual({ count: 1, title: "a" });

    // Focus entering a frame moves none between this document's elements:
    // the window blurs, and the frame becomes the active element.
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    try {
      window.dispatchEvent(new Event("blur"));
      await settle();
      expect(published.at(-1)).toBeNull();
    } finally {
      active.mockRestore();
    }

    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(published.at(-1)).toEqual({ count: 1, title: "a" });
    stop();
  });
});

describe("panel.undoClose chosen from Edit > Undo", () => {
  // jsdom has no layout: undo scrolls the caret into view, and CodeMirror
  // measures it through Range rects jsdom lacks.
  const rangeStubs = { getClientRects: () => [], getBoundingClientRect: () => new DOMRect() };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  beforeAll(() => {
    for (const [name, value] of Object.entries(rangeStubs)) {
      originals.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
      Object.defineProperty(Range.prototype, name, { configurable: true, value });
    }
  });
  afterAll(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
      else Reflect.deleteProperty(Range.prototype, name);
    }
  });

  it("reopens the close it named", async () => {
    seed("a");
    userClose(["a"]);
    await undoCloseAction().run(undefined, { dispatchSource: "menu" });
    expect(locationOf("a")).toBe("grid");
  });

  it("undoes the field instead when typing there has since outranked the close", async () => {
    trackNativeFieldEdits();
    seed("a");
    userClose(["a"]);
    const field = focusNew("input");
    typeInto(field, "since the close");
    const execCommand = vi.fn(() => true);
    Reflect.set(document, "execCommand", execCommand);
    try {
      await undoCloseAction().run(undefined, { dispatchSource: "menu" });
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
    expect(execCommand).toHaveBeenCalledWith("undo");
    expect(locationOf("a")).toBe("trash");
  });

  it("takes a Markdown editor's typing since the close back first, then the close, then older typing (#17180)", async () => {
    const editor = focusMarkdownEditor("# Plan\n");
    try {
      typeInEditor(editor, "older", 1000);
      seed("a");
      userClose(["a"]);
      typeInEditor(editor, " newer", 1001);
      expect(document.activeElement).toBe(editor.contentDOM);
      // Cmd+Z goes on to the editor rather than reopening, as Edit > Undo does.
      expect(undoCloseTakesKey(editor.contentDOM, false, true)).toBe(false);
      expect(undoCloseMenuState()).toBeNull();

      await undoCloseAction().run(undefined, { dispatchSource: "menu" });
      expect(editor.state.doc.toString()).toBe("# Plan\nolder");
      expect(locationOf("a")).toBe("trash");

      expect(undoCloseTakesKey(editor.contentDOM, false, true)).toBe(true);
      expect(undoCloseMenuState()).toEqual({ count: 1, title: "a" });
      await undoCloseAction().run(undefined, { dispatchSource: "menu" });
      expect(locationOf("a")).toBe("grid");
      expect(editor.state.doc.toString()).toBe("# Plan\nolder");

      await undoCloseAction().run(undefined, { dispatchSource: "menu" });
      expect(editor.state.doc.toString()).toBe("# Plan\n");
    } finally {
      editor.destroy();
    }
  });
});
