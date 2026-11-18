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
    open({ terminalId: "t1" });
    const first = useDecisionsInboxStore.getState().request.seq;
    open({ terminalId: "t1" });
    expect(useDecisionsInboxStore.getState().request.seq).toBeGreaterThan(first);
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
