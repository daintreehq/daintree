// @vitest-environment jsdom
import { bench, describe, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { ITheme } from "@xterm/xterm";
import type { CompletionTrigger, SlashCommand } from "@shared/types";
import { useEditorCompartments } from "../useEditorCompartments";
import { useEditorFactory } from "../useEditorFactory";
import { useCompartmentDriver } from "../useCompartmentDriver";
import { useContextDetection } from "../useContextDetection";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { clearDirectingState: () => {}, notifyUserInput: () => {} },
}));

const THEME: ITheme = { background: "#000000", foreground: "#ffffff" };
const COMMANDS = new Map<string, SlashCommand>();

function mountComposer() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const hook = renderHook(
    ({ isAutocompleteOpen }: { isAutocompleteOpen: boolean }) => {
      const compartments = useEditorCompartments();
      const editorHostRef = useRef<HTMLDivElement | null>(host);
      const editorViewRef = useRef<EditorView | null>(null);
      const contextUpdateRef = useRef<(u: ViewUpdate) => void>(() => {});
      const keymapHandlersRef = useRef(null);
      useEditorFactory({
        terminalId: "t1",
        editorHostRef,
        editorViewRef,
        value: "",
        disabled: false,
        placeholder: "Ask anything",
        effectiveTheme: THEME,
        commandMap: COMMANDS,
        compartments,
        contextUpdateRef,
        keymapHandlersRef,
        domEventHandlers: [],
        imagePasteExtension: [],
        filePasteExtension: [],
        plainPasteKeymap: [],
      });
      useCompartmentDriver({
        editorViewRef,
        ...compartments,
        effectiveTheme: THEME,
        placeholder: "Ask anything",
        disabled: false,
        commandMap: COMMANDS,
        isAutocompleteOpen,
      });
    },
    { initialProps: { isAutocompleteOpen: false } }
  );
  return {
    hook,
    dispose: () => {
      hook.unmount();
      host.remove();
    },
  };
}

function measureDispatches() {
  const spy = vi.spyOn(EditorView.prototype, "dispatch");
  const { hook, dispose } = mountComposer();
  const onMount = spy.mock.calls.length;
  spy.mockClear();
  hook.rerender({ isAutocompleteOpen: true });
  hook.rerender({ isAutocompleteOpen: false });
  const perCycle = spy.mock.calls.length;
  dispose();
  spy.mockRestore();
  return { onMount, perCycle };
}

const { onMount, perCycle } = measureDispatches();
process.stderr.write(
  `[composer] view.dispatch calls — mount: ${onMount}, autocomplete open+close: ${perCycle}\n`
);

// ~200 KB multi-line draft, the shape of a large pasted prompt.
const LINE = "const value = computeSomething(alpha, beta, gamma); // explanatory comment..\n";
const BIG_DOC = LINE.repeat(Math.ceil(200_000 / LINE.length));
const baseState = EditorState.create({ doc: BIG_DOC });
const CARETS = Array.from({ length: 1000 }, (_, i) =>
  Math.floor(((i * 7919) % 1000) * (BIG_DOC.length / 1000))
);
const selectionStates = CARETS.map(
  (caret) => baseState.update({ selection: { anchor: caret } }).state
);
const typedStates: EditorState[] = [];
{
  let s = baseState.update({ selection: { anchor: BIG_DOC.length / 2 } }).state;
  for (let i = 0; i < 1000; i++) {
    const head = s.selection.main.head;
    s = s.update({
      changes: { from: head, insert: "x" },
      selection: { anchor: head + 1 },
      userEvent: "input.type",
    }).state;
    typedStates.push(s);
  }
}

const TYPED_TR = [{ isUserEvent: (e: string) => e === "input" || e === "input.type" }];
const { result: detection } = renderHook(() => {
  const latestRef = useRef({
    isInHistoryMode: false,
    terminalId: "t1",
    resetHistoryIndex: () => {},
  });
  return useContextDetection({
    latestRef,
    activeTriggers: new Set<CompletionTrigger>(["/", "@", "$"]),
    applyDocChange: () => true,
    consumeExternalValueFlag: () => false,
    setActiveCompletionContext: () => {},
  });
});
const handle = (u: Partial<ViewUpdate>) =>
  detection.current.handleUpdateRef.current(u as unknown as ViewUpdate);

function selectionOnlyUpdates() {
  for (const state of selectionStates) {
    handle({ state, docChanged: false, selectionSet: true, focusChanged: false, transactions: [] });
  }
}

function typedUpdates() {
  for (const state of typedStates) {
    handle({
      state,
      docChanged: true,
      selectionSet: true,
      focusChanged: false,
      transactions: TYPED_TR as unknown as ViewUpdate["transactions"],
    });
  }
}

describe("composer compartment driver", () => {
  bench("mount + one autocomplete open/close cycle", () => {
    const { hook, dispose } = mountComposer();
    hook.rerender({ isAutocompleteOpen: true });
    hook.rerender({ isAutocompleteOpen: false });
    dispose();
  });
});

describe("context detection (200 KB draft)", () => {
  bench("1000 selection-only updates", selectionOnlyUpdates);
  bench("1000 typed-character updates", typedUpdates);
});
