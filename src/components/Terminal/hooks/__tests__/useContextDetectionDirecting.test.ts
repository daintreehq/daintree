// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { EditorState } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

const service = vi.hoisted(() => ({
  notifyComposerDraft: vi.fn(),
  releaseComposerDraft: vi.fn(),
  clearDirectingState: vi.fn(),
}));
vi.mock("@/services/TerminalInstanceService", () => ({ terminalInstanceService: service }));

import { useContextDetection } from "../useContextDetection";

function makeUpdate(text: string, userEvents: string[]): ViewUpdate {
  const transactions = userEvents.map((event) => ({
    isUserEvent: (probe: string) => event === probe || event.startsWith(`${probe}.`),
  }));
  return {
    focusChanged: false,
    docChanged: true,
    selectionSet: false,
    transactions,
    state: EditorState.create({ doc: text, selection: { anchor: 0 } }),
    view: { hasFocus: true },
  } as unknown as ViewUpdate;
}

function setupHook(external: boolean) {
  const { result } = renderHook(() => {
    const latestRef = useRef({
      isInHistoryMode: false,
      terminalId: "t1",
      resetHistoryIndex: () => {},
    });
    return useContextDetection({
      latestRef,
      activeTriggers: new Set(),
      applyDocChange: () => true,
      consumeExternalValueFlag: () => external,
      setActiveCompletionContext: () => {},
    });
  });
  return (update: ViewUpdate) => result.current.handleUpdateRef.current(update);
}

describe("useContextDetection directing signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds directing while the user edits a non-empty draft", () => {
    const handle = setupHook(false);
    handle(makeUpdate("hel", ["input.type"]));
    handle(makeUpdate("he", ["delete.backward"]));
    expect(service.notifyComposerDraft).toHaveBeenCalledTimes(2);
    expect(service.notifyComposerDraft).toHaveBeenCalledWith("t1");
    expect(service.clearDirectingState).not.toHaveBeenCalled();
  });

  it("clears directing when the user empties the draft", () => {
    const handle = setupHook(false);
    handle(makeUpdate("  ", ["delete.backward"]));
    expect(service.clearDirectingState).toHaveBeenCalledWith("t1");
    expect(service.notifyComposerDraft).not.toHaveBeenCalled();
  });

  it("releases the hold when the draft is emptied programmatically, as after a send", () => {
    const handle = setupHook(true);
    handle(makeUpdate("", []));
    expect(service.releaseComposerDraft).toHaveBeenCalledWith("t1");
    expect(service.clearDirectingState).not.toHaveBeenCalled();
  });

  it("a programmatic non-empty value neither holds nor releases", () => {
    const handle = setupHook(true);
    handle(makeUpdate("restored draft", []));
    expect(service.notifyComposerDraft).not.toHaveBeenCalled();
    expect(service.releaseComposerDraft).not.toHaveBeenCalled();
  });
});
