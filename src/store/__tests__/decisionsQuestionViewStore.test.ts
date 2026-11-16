import { beforeEach, describe, expect, it } from "vitest";
import { useDecisionsQuestionViewStore } from "../decisionsQuestionViewStore";

describe("decisionsQuestionViewStore", () => {
  beforeEach(() => useDecisionsQuestionViewStore.setState({ isOpen: false, request: null }));

  it("opens on the chosen question, listing each id once", () => {
    useDecisionsQuestionViewStore.getState().open("t1", ["a", "b", "a", "c"], "c");
    expect(useDecisionsQuestionViewStore.getState()).toMatchObject({
      isOpen: true,
      request: { terminalId: "t1", questionIds: ["a", "b", "c"], index: 2 },
    });
  });

  it("ignores a question that isn't listed, leaving an open view as it was", () => {
    const store = useDecisionsQuestionViewStore;
    store.getState().open("t1", ["a", "b"], "b");
    const before = store.getState().request;
    store.getState().open("t2", ["x"], "z");
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
    expect(store.getState().request).toEqual({
      terminalId: "t1",
      questionIds: ["a", "b"],
      index: 1,
    });
  });
});
