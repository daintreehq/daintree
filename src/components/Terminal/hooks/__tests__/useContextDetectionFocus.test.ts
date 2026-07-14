// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { ViewUpdate } from "@codemirror/view";
import type { CompletionTrigger } from "@shared/types";
import { useContextDetection } from "../useContextDetection";

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
    state: {
      doc: { toString: () => text, length: text.length },
      selection: { main: { head: opts.caret ?? 0 } },
    },
    view: { hasFocus: opts.hasFocus },
  } as unknown as ViewUpdate;
}

function setupHook(activeTriggers: CompletionTrigger[] = ["/", "$", "@"]) {
  const setIsEditorFocused = vi.fn();
  const setActiveCompletionContext = vi.fn();
  const applyDocChange = vi.fn(() => false);
  const consumeExternalValueFlag = vi.fn(() => false);
  const onUserType = vi.fn();

  const { result } = renderHook(() => {
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

  return { result, setIsEditorFocused, setActiveCompletionContext, onUserType };
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
