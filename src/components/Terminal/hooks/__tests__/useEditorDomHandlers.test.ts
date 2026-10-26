// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { FILE_DRAG_MIME } from "@/lib/fileDragPayload";

type DropHandler = (event: Event, view: unknown) => boolean;

// The extension factory is stubbed to hand its argument straight back, so the
// hook's return value *is* the handler map CodeMirror would call. That keeps
// this suite on the classification each drag flavour gets, and off CodeMirror's
// private plugin shape, which carries no compatibility promise across 6.x.
// What the classification then costs CodeMirror is a live-editor question, and
// `useEditorDomHandlers.liveEditor.test.ts` answers it there.
const factory = { calls: 0 };

vi.mock("@codemirror/view", () => ({
  EditorView: {
    domEventHandlers: (handlers: Record<string, DropHandler>) => {
      factory.calls++;
      return handlers;
    },
  },
}));

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: { getState: () => ({ isVoiceSubmitting: () => false }) },
}));

const { useEditorDomHandlers } = await import("../useEditorDomHandlers");

type Params = Parameters<typeof useEditorDomHandlers>[0];

function params(): Params {
  return {
    latestRef: { current: null },
    editorViewRef: { current: null },
    isComposingRef: { current: false },
    handledEnterRef: { current: false },
    lastEnterKeydownNewlineRef: { current: false },
    submitAfterCompositionRef: { current: false },
    applyAutocompleteSelection: vi.fn(() => true),
    sendFromEditor: vi.fn(),
    rootRef: { current: null },
    setActiveCompletionContext: vi.fn(),
  };
}

function registersDrop(value: unknown): value is { drop: DropHandler } {
  return (
    typeof value === "object" &&
    value !== null &&
    "drop" in value &&
    typeof value.drop === "function"
  );
}

/** Narrowed rather than asserted, so a stub that stopped handing the map back
 * fails here instead of quietly turning every case below into a no-op. */
function dropHandlerOf(extension: unknown): DropHandler {
  if (!registersDrop(extension)) throw new Error("the hook registered no drop handler");
  return extension.drop;
}

/** Only `dataTransfer.types` is populated: anything the handler read beyond it
 * would mean it had started duplicating the chip path it exists to defer to. */
function dropEvent(types: readonly string[] | null) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  Object.defineProperty(event, "dataTransfer", {
    value: types === null ? null : { types },
  });
  return { event, stopPropagation };
}

function renderHandlers() {
  const { result, rerender } = renderHook((p: Params) => useEditorDomHandlers(p), {
    initialProps: params(),
  });
  return { result, rerender };
}

/** Does CodeMirror's own drop handling get retired for this drag? */
function claimed(types: readonly string[] | null): boolean {
  const { result } = renderHandlers();
  const { event } = dropEvent(types);
  return dropHandlerOf(result.current)(event, {});
}

beforeEach(() => {
  factory.calls = 0;
});

describe("useEditorDomHandlers drop", () => {
  it("leaves a drag with no dataTransfer to CodeMirror", () => {
    expect(claimed(null)).toBe(false);
  });

  it("claims an OS file drop so CodeMirror never reads it as text", () => {
    expect(claimed(["Files"])).toBe(true);
  });

  // Finder ships a file drag with a text flavour attached. Falling through on
  // the text flavour would leave CodeMirror's FileReader branch to run, which
  // is #11710 itself.
  it("claims a file drop that also carries a text flavour", () => {
    expect(claimed(["Files", "text/plain"])).toBe(true);
  });

  // Guards the gate against narrowing to `dataTransfer.files`, which an in-app
  // drag never populates (#11576).
  it("claims an in-app file drag", () => {
    expect(claimed([FILE_DRAG_MIME])).toBe(true);
  });

  it("leaves a selection drag inside the editor to CodeMirror", () => {
    expect(claimed(["text/plain"])).toBe(false);
  });

  // Separate from the case above: a gate that claimed anything carrying more
  // than one flavour would pass that one and fail this.
  it("leaves an external text or link drop to CodeMirror", () => {
    expect(claimed(["text/plain", "text/uri-list"])).toBe(false);
  });
});

describe("useEditorDomHandlers", () => {
  // `useEditorFactory` builds the editor state under an effect keyed on
  // terminalId alone, so an extension rebuilt on any other change is handed to
  // an editor that never installs it — the handlers would silently go stale.
  it("hands back the extension it built at mount after an unrelated rerender", () => {
    const { result, rerender } = renderHandlers();
    const first = result.current;

    rerender(params());

    expect(result.current).toBe(first);
    expect(factory.calls).toBe(1);
  });
});

type InputHandler = (event: Event, view: unknown) => boolean;

function registersBeforeInput(value: unknown): value is { beforeinput: InputHandler } {
  return (
    typeof value === "object" &&
    value !== null &&
    "beforeinput" in value &&
    typeof value.beforeinput === "function"
  );
}

describe("useEditorDomHandlers Enter from beforeinput", () => {
  function enterOnEmptyDoc(isVoiceActiveForPanel: boolean) {
    const onSendKey = vi.fn<(key: string) => void>();
    const p = params();
    p.latestRef = {
      current: {
        terminalId: "t1",
        disabled: false,
        isAutocompleteOpen: false,
        autocompleteItems: [],
        staleItemKeys: new Set<string>(),
        selectedIndex: 0,
        value: "",
        onSendKey,
        isVoiceActiveForPanel,
        isExpanded: false,
      },
    };
    const { result } = renderHook(() => useEditorDomHandlers(p));
    if (!registersBeforeInput(result.current)) throw new Error("no beforeinput handler");
    const event = new InputEvent("beforeinput", { inputType: "insertLineBreak", cancelable: true });
    result.current.beforeinput(event, {});
    return { onSendKey, sendFromEditor: p.sendFromEditor };
  }

  it("finishes an active dictation even while its words haven't reached the doc", () => {
    const { onSendKey, sendFromEditor } = enterOnEmptyDoc(true);
    expect(sendFromEditor).toHaveBeenCalledTimes(1);
    expect(onSendKey).not.toHaveBeenCalled();
  });

  it("passes a bare Enter through for an empty doc when nothing is being dictated", () => {
    const { onSendKey, sendFromEditor } = enterOnEmptyDoc(false);
    expect(onSendKey).toHaveBeenCalledWith("enter");
    expect(sendFromEditor).not.toHaveBeenCalled();
  });
});
