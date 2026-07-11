// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { ViewUpdate } from "@codemirror/view";
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
}): ViewUpdate {
  return {
    focusChanged: opts.focusChanged,
    docChanged: opts.docChanged ?? false,
    selectionSet: opts.selectionSet ?? false,
    transactions: [],
    state: {
      doc: { toString: () => "", length: 0 },
      selection: { main: { head: 0 } },
    },
    view: { hasFocus: opts.hasFocus },
  } as unknown as ViewUpdate;
}

function setupHook() {
  const setIsEditorFocused = vi.fn();
  const setActiveCompletionContext = vi.fn();
  const applyDocChange = vi.fn(() => false);
  const consumeExternalValueFlag = vi.fn(() => false);

  const { result } = renderHook(() => {
    const latestRef = useRef<LatestRefShape | null>({
      isInHistoryMode: false,
      terminalId: "t1",
      resetHistoryIndex: () => {},
    });
    return useContextDetection({
      latestRef,
      activeTriggers: new Set(["/", "$", "@"]),
      applyDocChange,
      consumeExternalValueFlag,
      setActiveCompletionContext,
      setIsEditorFocused,
    });
  });

  return { result, setIsEditorFocused };
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
