// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { ITheme } from "@xterm/xterm";
import type { SlashCommand } from "@shared/types";
import { useEditorCompartments } from "../useEditorCompartments";
import { useEditorFactory } from "../useEditorFactory";
import { useCompartmentDriver } from "../useCompartmentDriver";

const THEME: ITheme = { background: "#000000", foreground: "#ffffff" };
const COMMANDS = new Map<string, SlashCommand>();

interface Props {
  terminalId: string;
  disabled: boolean;
  isAutocompleteOpen: boolean;
  placeholder: string;
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

function mount(initial: Partial<Props> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
  let viewRef: React.RefObject<EditorView | null> = { current: null };
  const hook = renderHook(
    ({ terminalId, disabled, isAutocompleteOpen, placeholder }: Props) => {
      const compartments = useEditorCompartments();
      const editorHostRef = useRef<HTMLDivElement | null>(host);
      const editorViewRef = useRef<EditorView | null>(null);
      viewRef = editorViewRef;
      const contextUpdateRef = useRef<(u: ViewUpdate) => void>(() => {});
      const keymapHandlersRef = useRef(null);
      useEditorFactory({
        terminalId,
        editorHostRef,
        editorViewRef,
        value: "",
        disabled,
        placeholder,
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
        placeholder,
        disabled,
        commandMap: COMMANDS,
        isAutocompleteOpen,
      });
    },
    {
      initialProps: {
        terminalId: "t1",
        disabled: false,
        isAutocompleteOpen: false,
        placeholder: "Ask anything",
        ...initial,
      },
    }
  );
  cleanup = () => {
    hook.unmount();
    host.remove();
  };
  return { hook, dispatch, view: () => viewRef.current! };
}

const editable = (view: EditorView) => view.state.facet(EditorView.editable);
const placeholderText = (view: EditorView) =>
  view.dom.querySelector(".cm-placeholder")?.textContent ?? null;

describe("useCompartmentDriver with a real editor", () => {
  it("does not dispatch on mount and keeps the factory's disabled state", () => {
    const { dispatch, view } = mount({ disabled: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(editable(view())).toBe(false);
  });

  it("applies prop changes after mount", () => {
    const { hook, view } = mount({ disabled: true });
    hook.rerender({
      terminalId: "t1",
      disabled: false,
      isAutocompleteOpen: false,
      placeholder: "Next",
    });
    expect(editable(view())).toBe(true);
    expect(placeholderText(view())).toBe("Next");
  });

  it("unlocks a view rebuilt for a new terminal", () => {
    const { hook, view } = mount({ disabled: true });
    const first = view();
    hook.rerender({
      terminalId: "t2",
      disabled: true,
      isAutocompleteOpen: false,
      placeholder: "Ask anything",
    });
    expect(view()).not.toBe(first);
    hook.rerender({
      terminalId: "t2",
      disabled: false,
      isAutocompleteOpen: false,
      placeholder: "Ask anything",
    });
    expect(editable(view())).toBe(true);
  });

  it("batches an autocomplete open/close into one dispatch each", () => {
    const { hook, dispatch } = mount();
    const base = { terminalId: "t1", disabled: false, placeholder: "Ask anything" };
    hook.rerender({ ...base, isAutocompleteOpen: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    hook.rerender({ ...base, isAutocompleteOpen: false });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
