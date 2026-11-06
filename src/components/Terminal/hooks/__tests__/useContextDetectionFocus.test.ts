// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import type { CompletionTrigger } from "@shared/types";

const service = vi.hoisted(() => ({
  notifyComposerDraft: vi.fn(),
  releaseComposerDraft: vi.fn(),
  clearDirectingState: vi.fn(),
}));
vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = service;
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

import { useContextDetection } from "../useContextDetection";
import { completionBoundary } from "../../inputEditorExtensions/completionBoundary";
import { getActiveCompletionContext } from "../../hybridInputParsing";

import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

// The service mock never evaluates the real module, so nothing builds it.
await loadTerminalService();

interface LatestRefShape {
  isInHistoryMode: boolean;
  terminalId: string;
  projectId?: string;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
}

function makeUpdate(opts: {
  focusChanged: boolean;
  hasFocus: boolean;
  docChanged?: boolean;
  selectionSet?: boolean;
  text?: string;
  caret?: number;
  /** CM6 user-event names, one per simulated transaction (e.g. "input.type"). */
  userEvents?: string[];
  /** The editor state after the update, in place of one built from `text`. */
  state?: EditorState;
}): ViewUpdate {
  const text = opts.text ?? "";
  // CM6 user events are hierarchical: a transaction tagged "input.type"
  // satisfies isUserEvent("input") as well as isUserEvent("input.type").
  const transactions = (opts.userEvents ?? []).map((event) => ({
    isUserEvent: (probe: string) => event === probe || event.startsWith(`${probe}.`),
  }));
  return {
    focusChanged: opts.focusChanged,
    docChanged: opts.docChanged ?? false,
    selectionSet: opts.selectionSet ?? false,
    transactions,
    state: opts.state ?? EditorState.create({ doc: text, selection: { anchor: opts.caret ?? 0 } }),
    view: { hasFocus: opts.hasFocus },
  } as unknown as ViewUpdate;
}

function setupHook(activeTriggers: CompletionTrigger[] = ["/", "$", "@"], external = false) {
  const setIsEditorFocused = vi.fn();
  const setActiveCompletionContext = vi.fn();
  const applyDocChange = vi.fn(() => false);
  const consumeExternalValueFlag = vi.fn(() => external);
  const onUserType = vi.fn();

  const { result, unmount } = renderHook(() => {
    const latestRef = useRef<LatestRefShape | null>({
      isInHistoryMode: false,
      terminalId: "t1",
      resetHistoryIndex: () => {},
    });
    return useContextDetection({
      latestRef,
      activeTriggers: new Set(activeTriggers),
      applyDocChange,
      consumeExternalValueFlag,
      setActiveCompletionContext,
      setIsEditorFocused,
      onUserType,
    });
  });

  return { result, unmount, setIsEditorFocused, setActiveCompletionContext, onUserType };
}

describe("useContextDetection focus tracking", () => {
  it("calls setIsEditorFocused(true) when focusChanged fires with hasFocus=true", () => {
    const { result, setIsEditorFocused } = setupHook();
    result.current.handleUpdateRef.current(makeUpdate({ focusChanged: true, hasFocus: true }));
    expect(setIsEditorFocused).toHaveBeenCalledWith(true);
  });

  it("calls setIsEditorFocused(false) when focusChanged fires with hasFocus=false", () => {
    const { result, setIsEditorFocused } = setupHook();
    result.current.handleUpdateRef.current(makeUpdate({ focusChanged: true, hasFocus: false }));
    expect(setIsEditorFocused).toHaveBeenCalledWith(false);
  });

  it("does not call setIsEditorFocused when focusChanged is false", () => {
    const { result, setIsEditorFocused } = setupHook();
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, docChanged: true })
    );
    expect(setIsEditorFocused).not.toHaveBeenCalled();
  });
});

/**
 * "Last agent typed to" (#11134) must mean *typing*, not focus and not any
 * document change — otherwise the type-anywhere rescue routes a prompt into an
 * agent the user merely pasted into, or never touched at all.
 */
describe("useContextDetection user-typing signal", () => {
  it("fires when the user types", () => {
    const { result, onUserType } = setupHook();
    result.current.handleUpdateRef.current(
      makeUpdate({
        focusChanged: false,
        hasFocus: true,
        docChanged: true,
        text: "a",
        userEvents: ["input.type"],
      })
    );
    expect(onUserType).toHaveBeenCalledTimes(1);
  });

  it("fires once even when an update carries several typing transactions", () => {
    const { result, onUserType } = setupHook();
    result.current.handleUpdateRef.current(
      makeUpdate({
        focusChanged: false,
        hasFocus: true,
        docChanged: true,
        text: "ab",
        userEvents: ["input.type", "input.type"],
      })
    );
    expect(onUserType).toHaveBeenCalledTimes(1);
  });

  it("does not fire on paste, deletion, or history navigation", () => {
    const { result, onUserType } = setupHook();
    for (const event of ["input.paste", "delete.backward", "select.pointer"]) {
      result.current.handleUpdateRef.current(
        makeUpdate({
          focusChanged: false,
          hasFocus: true,
          docChanged: true,
          text: "x",
          userEvents: [event],
        })
      );
    }
    expect(onUserType).not.toHaveBeenCalled();
  });

  it("does not fire on a programmatic doc change with no user event", () => {
    const { result, onUserType } = setupHook();
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, docChanged: true, text: "x" })
    );
    expect(onUserType).not.toHaveBeenCalled();
  });

  it("does not fire on a focus-only update", () => {
    const { result, onUserType } = setupHook();
    result.current.handleUpdateRef.current(makeUpdate({ focusChanged: true, hasFocus: true }));
    expect(onUserType).not.toHaveBeenCalled();
  });
});

describe("useContextDetection trigger detection", () => {
  it("opens a $ context when $ is an active trigger", () => {
    const { result, setActiveCompletionContext } = setupHook(["/", "$", "@"]);
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, docChanged: true, text: "$neo", caret: 4 })
    );
    expect(setActiveCompletionContext).toHaveBeenCalledWith(
      expect.objectContaining({ triggerChar: "$", start: 0, query: "neo" })
    );
  });

  it("does not open a $ context when $ is not an active trigger", () => {
    const { result, setActiveCompletionContext } = setupHook(["/", "@"]);
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, docChanged: true, text: "$neo", caret: 4 })
    );
    // Only the initial null (no context) may be emitted — never a $ context.
    for (const call of setActiveCompletionContext.mock.calls) {
      expect(call[0]).toBeNull();
    }
  });
});

describe("useContextDetection multi-line drafts", () => {
  it("ends a token typed against a word on a later line at that word (#15872)", () => {
    const { result, setActiveCompletionContext } = setupHook(["/", "@"]);
    const doc = "first line\nsee App.tsx";
    let state = EditorState.create({
      doc,
      selection: { anchor: "first line\nsee ".length },
      extensions: [completionBoundary],
    });
    for (const char of "@src/") {
      const at = state.selection.main.head;
      state = state.update({
        changes: { from: at, insert: char },
        selection: { anchor: at + 1 },
        userEvent: "input.type",
      }).state;
    }
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, docChanged: true, state })
    );
    const start = "first line\nsee ".length;
    expect(setActiveCompletionContext).toHaveBeenLastCalledWith({
      triggerChar: "@",
      start,
      tokenEnd: start + "@src/".length,
      query: "src/",
    });
  });

  it("reports doc-absolute offsets for a token on a later line", () => {
    const { result, setActiveCompletionContext } = setupHook(["/", "@"]);
    const text = "first line\nsecond @src/Ap more\nthird";
    const caret = text.indexOf("@src/Ap") + "@src/Ap".length;
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, selectionSet: true, text, caret })
    );
    expect(setActiveCompletionContext).toHaveBeenLastCalledWith({
      triggerChar: "@",
      start: text.indexOf("@"),
      tokenEnd: caret,
      query: "src/Ap",
    });
  });

  it("does not extend a token across a line break", () => {
    const { result, setActiveCompletionContext } = setupHook(["/", "@"]);
    const text = "@foo\nbar";
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, selectionSet: true, text, caret: 4 })
    );
    expect(setActiveCompletionContext).toHaveBeenLastCalledWith({
      triggerChar: "@",
      start: 0,
      tokenEnd: 4,
      query: "foo",
    });
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, selectionSet: true, text, caret: 7 })
    );
    expect(setActiveCompletionContext).toHaveBeenLastCalledWith(null);
  });

  it("rebases a token end that lies past the caret", () => {
    const { result, setActiveCompletionContext } = setupHook(["/", "@"]);
    const text = "intro\n@src/App.tsx tail";
    const caret = text.indexOf("@") + "@src".length;
    result.current.handleUpdateRef.current(
      makeUpdate({ focusChanged: false, hasFocus: true, selectionSet: true, text, caret })
    );
    expect(setActiveCompletionContext).toHaveBeenLastCalledWith({
      triggerChar: "@",
      start: text.indexOf("@"),
      tokenEnd: text.indexOf(" tail"),
      query: "src",
    });
  });

  it("matches the whole-document scan at every caret position", () => {
    const triggers = ["/", "@", "$"] as CompletionTrigger[];
    const docs = [
      "",
      "\n\n",
      "/help me\n@src/App.tsx and $VAR\n\n  /compact",
      "a\r\n@x\r\n/y z",
      "email@x.com\n@@dup //no\n@diff:staged\ttab",
      "trail @\n/\n$\u2028@after-ls",
      "@a\n@b\n@c",
    ];
    for (const text of docs) {
      const { result, setActiveCompletionContext } = setupHook(triggers);
      const state = EditorState.create({ doc: text });
      const flat = state.doc.toString();
      for (let caret = 0; caret <= state.doc.length; caret++) {
        result.current.handleUpdateRef.current(
          makeUpdate({ focusChanged: false, hasFocus: true, selectionSet: true, text, caret })
        );
        // The hook emits only on change, so its latest emission is its current value.
        const current = setActiveCompletionContext.mock.calls.at(-1)?.[0] ?? null;
        expect(current).toEqual(getActiveCompletionContext(flat, caret, new Set(triggers)));
      }
    }
  });
});

describe("useContextDetection directing signals", () => {
  beforeEach(() => {
    service.notifyComposerDraft.mockClear();
    service.releaseComposerDraft.mockClear();
    service.clearDirectingState.mockClear();
  });

  function edit(text: string, userEvents: string[]) {
    return makeUpdate({ focusChanged: false, hasFocus: true, docChanged: true, text, userEvents });
  }

  it("holds directing while the user edits a non-empty draft", () => {
    const { result } = setupHook();
    result.current.handleUpdateRef.current(edit("hel", ["input.type"]));
    result.current.handleUpdateRef.current(edit("he", ["delete.backward"]));
    expect(service.notifyComposerDraft).toHaveBeenCalledTimes(2);
    expect(service.notifyComposerDraft).toHaveBeenCalledWith("t1");
    expect(service.clearDirectingState).not.toHaveBeenCalled();
  });

  it("clears directing when the user empties the draft", () => {
    const { result } = setupHook();
    result.current.handleUpdateRef.current(edit("  ", ["delete.backward"]));
    expect(service.clearDirectingState).toHaveBeenCalledWith("t1");
    expect(service.notifyComposerDraft).not.toHaveBeenCalled();
  });

  it("releases the hold when the draft is emptied programmatically, as after a send", () => {
    const { result } = setupHook(undefined, true);
    result.current.handleUpdateRef.current(edit("", []));
    expect(service.releaseComposerDraft).toHaveBeenCalledWith("t1");
    expect(service.clearDirectingState).not.toHaveBeenCalled();
  });

  it("releases the hold when an unannotated edit empties the draft", () => {
    const { result } = setupHook();
    result.current.handleUpdateRef.current(edit("", []));
    expect(service.releaseComposerDraft).toHaveBeenCalledWith("t1");
    expect(service.clearDirectingState).not.toHaveBeenCalled();
  });

  it("a programmatic non-empty value neither holds nor releases", () => {
    const { result } = setupHook(undefined, true);
    result.current.handleUpdateRef.current(edit("restored draft", []));
    expect(service.notifyComposerDraft).not.toHaveBeenCalled();
    expect(service.releaseComposerDraft).not.toHaveBeenCalled();
  });

  it("releases a held draft when the composer unmounts", () => {
    const { result, unmount } = setupHook();
    result.current.handleUpdateRef.current(edit("draft", ["input.type"]));
    unmount();
    expect(service.releaseComposerDraft).toHaveBeenCalledWith("t1");
  });

  it("does not release on unmount once the draft was emptied", () => {
    const { result, unmount } = setupHook();
    result.current.handleUpdateRef.current(edit("draft", ["input.type"]));
    result.current.handleUpdateRef.current(edit("", ["delete.backward"]));
    service.releaseComposerDraft.mockClear();
    unmount();
    expect(service.releaseComposerDraft).not.toHaveBeenCalled();
  });

  it("does not release on unmount when nothing was held", () => {
    const { unmount } = setupHook();
    unmount();
    expect(service.releaseComposerDraft).not.toHaveBeenCalled();
  });
});
