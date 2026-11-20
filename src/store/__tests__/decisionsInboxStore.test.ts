import { beforeEach, describe, expect, it } from "vitest";
import { useDecisionsInboxStore } from "../decisionsInboxStore";

beforeEach(() => {
  useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
});

describe("useDecisionsInboxStore (#17231)", () => {
  it("opens from anywhere with no pane, and from a pane's dropdown with that pane", () => {
    useDecisionsInboxStore.getState().open();
    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: true,
      request: { terminalId: null },
    });
    useDecisionsInboxStore.getState().open({ terminalId: "t1" });
    expect(useDecisionsInboxStore.getState().request.terminalId).toBe("t1");
  });

  it("makes every opening a new request, even while open", () => {
    const { open } = useDecisionsInboxStore.getState();
    open({ terminalId: "t1", question: { terminalId: "t1", questionId: "q1" } });
    const first = useDecisionsInboxStore.getState().request.seq;
    open({ terminalId: "t1" });
    expect(useDecisionsInboxStore.getState().request.seq).toBeGreaterThan(first);
    // An opening that asks for no question carries none from the one before (#18047).
    expect(useDecisionsInboxStore.getState().request.question).toBeNull();
  });

  it("opens at a question asked for, and carries none into an opening that asks for none (#18047)", () => {
    const { open } = useDecisionsInboxStore.getState();
    open({ terminalId: "t1", question: { terminalId: "t1", questionId: "q1" } });
    expect(useDecisionsInboxStore.getState().request).toMatchObject({
      terminalId: "t1",
      question: { terminalId: "t1", questionId: "q1" },
    });
    useDecisionsInboxStore.getState().close();
    open();
    expect(useDecisionsInboxStore.getState().request.question).toBeNull();
  });

  it("shows a question asked for while open in the same opening, keeping where the close returns", () => {
    const { open } = useDecisionsInboxStore.getState();
    open({ terminalId: "t1" });
    const opening = useDecisionsInboxStore.getState().request;
    const reference = { hostId: "local", projectId: "p1", terminalId: "t2", questionId: "q2" };
    open({ question: { terminalId: "t2", questionId: "q2", reference, threadMessageId: "m-1" } });
    const asked = useDecisionsInboxStore.getState().request;
    expect(asked).toMatchObject({
      terminalId: "t1",
      seq: opening.seq,
      openedAt: opening.openedAt,
      question: { reference, threadMessageId: "m-1" },
    });
    // Asked for again, it is a new ask, so it lands even when it names the same question.
    open({ question: { terminalId: "t2", questionId: "q2", reference, threadMessageId: "m-1" } });
    expect(useDecisionsInboxStore.getState().request.ask).toBeGreaterThan(asked.ask ?? 0);
    expect(useDecisionsInboxStore.getState().request.seq).toBe(opening.seq);
  });

  it("carries where the close returns and what it prefers into one opening only (#18048)", () => {
    const { open } = useDecisionsInboxStore.getState();
    open({ prefer: "stopped" });
    expect(useDecisionsInboxStore.getState().request).toMatchObject({
      prefer: "stopped",
      returnFocusTo: null,
    });
    useDecisionsInboxStore.getState().close();
    open({
      question: { terminalId: "t1", questionId: "q1" },
      returnFocusTo: "canopy-card-t1",
    });
    expect(useDecisionsInboxStore.getState().request).toMatchObject({
      prefer: null,
      returnFocusTo: "canopy-card-t1",
    });
    // A question asked for while open keeps the opening's own.
    open({ question: { terminalId: "t2", questionId: "q2" }, returnFocusTo: "elsewhere" });
    expect(useDecisionsInboxStore.getState().request.returnFocusTo).toBe("canopy-card-t1");
  });

  it("keeps the request through the close, so the closing dialog still knows where it came from", () => {
    useDecisionsInboxStore.getState().open({ terminalId: "t1" });
    useDecisionsInboxStore.getState().close();
    expect(useDecisionsInboxStore.getState()).toMatchObject({
      isOpen: false,
      request: { terminalId: "t1" },
    });
  });
});
