// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsOpenQuestionRequest } from "@shared/types/decisionsQuestion";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { DecisionQuestionHost } from "../DecisionQuestionHost";

vi.mock("../DecisionQuestionDialog", () => ({ DecisionQuestionDialog: () => null }));

const reference = {
  hostId: "host-1",
  projectId: "project-other",
  terminalId: "term-closed",
  questionId: "q-1",
};

let handlers: Map<string, (payload: DecisionsOpenQuestionRequest) => void>;
let off: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handlers = new Map();
  off = vi.fn();
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      events: {
        on: vi.fn((name: string, handler: (payload: DecisionsOpenQuestionRequest) => void) => {
          handlers.set(name, handler);
          return off;
        }),
      },
    },
  });
  useDecisionsQuestionViewStore.setState({ isOpen: false, request: null });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

describe("DecisionQuestionHost", () => {
  it("opens the question a notification's click sends this view, by its reference", () => {
    render(<DecisionQuestionHost followsOpenRequests />);

    act(() => handlers.get("decisions:open-question")!({ reference }));

    const state = useDecisionsQuestionViewStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.request?.questions).toHaveLength(1);
    expect(state.request?.index).toBe(0);
  });

  it("stops following them once it unmounts", () => {
    const { unmount } = render(<DecisionQuestionHost followsOpenRequests />);

    unmount();

    expect(off).toHaveBeenCalledTimes(1);
  });

  it("follows none where it isn't asked to", () => {
    render(<DecisionQuestionHost />);

    expect(handlers.has("decisions:open-question")).toBe(false);
  });
});
