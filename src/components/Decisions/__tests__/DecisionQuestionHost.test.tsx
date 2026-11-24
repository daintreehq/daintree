// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsOpenQuestionRequest } from "@shared/types/decisionsQuestion";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { DecisionQuestionHost } from "../DecisionQuestionHost";

vi.mock("../DecisionQuestionDialog", () => ({ DecisionQuestionDialog: () => null }));

const reference = {
  hostId: "host-1",
  projectId: "project-other",
  terminalId: "term-closed",
  questionId: "q-1",
};

const handlers = new Map<string, Set<(payload: DecisionsOpenQuestionRequest) => void>>();

/** Main sending this view an open request, as the preload delivers it. */
function send(name: string, payload: DecisionsOpenQuestionRequest): void {
  for (const handler of [...(handlers.get(name) ?? [])]) handler(payload);
}

beforeEach(() => {
  handlers.clear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      events: {
        on: vi.fn((name: string, handler: (payload: DecisionsOpenQuestionRequest) => void) => {
          if (!handlers.has(name)) handlers.set(name, new Set());
          handlers.get(name)!.add(handler);
          return () => handlers.get(name)?.delete(handler);
        }),
      },
    },
  });
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
  useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("DecisionQuestionHost", () => {
  it("opens the inbox at the question a notification's click sends this view, by its reference (#18047)", () => {
    render(<DecisionQuestionHost followsOpenRequests />);

    act(() => send("decisions:open-question", { reference }));
    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: true,
      request: {
        terminalId: null,
        question: { terminalId: "term-closed", questionId: "q-1", reference },
      },
    });
    const opening = useDecisionsInboxStore.getState().request.seq;

    // A second click while the inbox is open shows its question in the same opening.
    const next = { ...reference, hostId: "host-2", questionId: "q-2" };
    act(() => send("decisions:open-question", { reference: next }));
    expect(useDecisionsInboxStore.getState().request).toMatchObject({
      seq: opening,
      question: { terminalId: "term-closed", questionId: "q-2", reference: next },
    });
    // Never the question view stacked over it.
    expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false);
  });

  it("opens a follow-up's question at that follow-up (#17235)", () => {
    render(<DecisionQuestionHost followsOpenRequests />);

    act(() => send("decisions:open-question", { reference, messageId: "ask-1" }));

    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: true,
      request: { question: { reference, threadMessageId: "ask-1" } },
    });
  });

  it("opens the inbox in a Remote Host window too: the question is this computer's", () => {
    window.__DAINTREE_HOST_ID__ = { id: "build-box" };
    try {
      render(<DecisionQuestionHost followsOpenRequests />);
      act(() => send("decisions:open-question", { reference }));
      expect(useDecisionsInboxStore.getState().request.question?.reference).toEqual(reference);
      expect(useDecisionsQuestionViewStore.getState().isOpen).toBe(false);
    } finally {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
    }
  });

  it("stops following them once it unmounts", () => {
    const { unmount } = render(<DecisionQuestionHost followsOpenRequests />);
    expect(handlers.get("decisions:open-question")?.size).toBe(1);

    unmount();
    act(() => send("decisions:open-question", { reference }));

    expect(handlers.get("decisions:open-question")?.size).toBe(0);
    expect(useDecisionsInboxStore.getState().isOpen).toBe(false);
  });

  it("follows none where it isn't asked to", () => {
    render(<DecisionQuestionHost />);

    expect(handlers.has("decisions:open-question")).toBe(false);
  });
});
