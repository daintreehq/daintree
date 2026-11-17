import { beforeEach, describe, expect, it } from "vitest";
import { useDecisionsQuestionViewStore } from "../decisionsQuestionViewStore";
import type { DecisionQuestionReference } from "@shared/types/decisionsQuestion";

const pane = (questionId: string, terminalId = "t1") => ({
  scope: "pane" as const,
  terminalId,
  questionId,
});

function ref(questionId: string, projectId = "project-a"): DecisionQuestionReference {
  return { hostId: "host_1", projectId, terminalId: "t1", questionId };
}

describe("decisionsQuestionViewStore", () => {
  beforeEach(() => useDecisionsQuestionViewStore.setState({ isOpen: false, request: null }));

  it("opens on the chosen question, listing each id once", () => {
    useDecisionsQuestionViewStore.getState().open("t1", ["a", "b", "a", "c"], "c");
    expect(useDecisionsQuestionViewStore.getState()).toMatchObject({
      isOpen: true,
      request: { questions: [pane("a"), pane("b"), pane("c")], index: 2 },
    });
  });

  it("ignores a question that isn't listed, leaving an open view as it was", () => {
    const store = useDecisionsQuestionViewStore;
    store.getState().open("t1", ["a", "b"], "b");
    const before = store.getState().request;
    store.getState().open("t2", ["x"], "z");
    store.getState().openReference([ref("x")], ref("z"));
    expect(store.getState().isOpen).toBe(true);
    expect(store.getState().request).toBe(before);
  });

  it("steps within the list and stops at either end", () => {
    const store = useDecisionsQuestionViewStore;
    store.getState().open("t1", ["a", "b"], "a");
    store.getState().step(-1);
    expect(store.getState().request?.index).toBe(0);
    store.getState().step(1);
    expect(store.getState().request?.index).toBe(1);
    store.getState().step(1);
    expect(store.getState().request?.index).toBe(1);
  });

  it("keeps the request through the close, so the closing view keeps its place", () => {
    const store = useDecisionsQuestionViewStore;
    store.getState().open("t1", ["a", "b"], "b");
    store.getState().close();
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().request).toEqual({ questions: [pane("a"), pane("b")], index: 1 });
  });

  it("opens a question by its reference among others from any project, each once (#17229)", () => {
    const store = useDecisionsQuestionViewStore;
    const listed = [ref("a"), ref("b", "project-b"), ref("a"), ref("c")];
    store.getState().openReference(listed, ref("b", "project-b"));
    expect(store.getState()).toMatchObject({
      isOpen: true,
      request: {
        questions: [
          { scope: "reference", reference: ref("a") },
          { scope: "reference", reference: ref("b", "project-b") },
          { scope: "reference", reference: ref("c") },
        ],
        index: 1,
      },
    });
    store.getState().step(1);
    expect(store.getState().request?.index).toBe(2);
  });

  it("matches a reference by everything it names, not its question id alone", () => {
    const store = useDecisionsQuestionViewStore;
    store.getState().openReference([ref("a", "project-a")], ref("a", "project-b"));
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().request).toBeNull();
  });
});
