import { beforeEach, describe, expect, it } from "vitest";
import type { HeldComposerSend } from "@shared/types/ipc/composerHold";
import { hasHeldComposerSend, useHeldComposerSendStore } from "../heldComposerSendStore";

function send(token: string, text = "ship it", terminalId = "t1"): HeldComposerSend {
  return {
    terminalId,
    token,
    text,
    imagePaths: [],
    heldAt: 1,
    expiresAt: 2,
    status: "held",
  };
}

const store = () => useHeldComposerSendStore.getState();

beforeEach(() => {
  useHeldComposerSendStore.setState({ held: {}, dropped: {}, refused: {}, endedTokens: [] });
});

describe("heldComposerSendStore", () => {
  it("keeps a dropped send's text and reason once main says why", () => {
    store().applyChange({ terminalId: "t1", held: send("a", "fix the tests") });
    expect(hasHeldComposerSend("t1")).toBe(true);

    store().applyChange({
      terminalId: "t1",
      held: null,
      ended: { token: "a", outcome: { kind: "dropped", reason: "typed" } },
    });
    expect(hasHeldComposerSend("t1")).toBe(false);
    expect(store().dropped.t1).toEqual({
      token: "a",
      text: "fix the tests",
      imagePaths: [],
      reason: "typed",
    });
  });

  it("forgets a delivered or withdrawn send without a note", () => {
    store().applyChange({ terminalId: "t1", held: send("a") });
    store().applyChange({
      terminalId: "t1",
      held: null,
      ended: { token: "a", outcome: { kind: "delivered" } },
    });
    expect(store().held).toEqual({});
    expect(store().dropped).toEqual({});
  });

  it("never brings back a send whose outcome arrived before the answer to its hold", () => {
    store().applyChange({
      terminalId: "t1",
      held: null,
      ended: { token: "a", outcome: { kind: "withdrawn" } },
    });
    store().noteHeld(send("a"));
    expect(hasHeldComposerSend("t1")).toBe(false);
  });

  it("clears the last drop note and refusal once a new send is held", () => {
    store().applyChange({ terminalId: "t1", held: send("a") });
    store().noteRefused("t1");
    store().applyChange({
      terminalId: "t1",
      held: null,
      ended: { token: "a", outcome: { kind: "dropped", reason: "restarted" } },
    });
    expect(store().refused).toEqual({});
    store().noteRefused("t1");

    store().noteHeld(send("b"));
    expect(store().dropped).toEqual({});
    store().applyChange({ terminalId: "t1", held: send("c") });
    expect(store().refused).toEqual({});
  });

  it("takes a reloaded view's snapshot, minus anything it saw end", () => {
    store().applyChange({
      terminalId: "t2",
      held: null,
      ended: { token: "b", outcome: { kind: "delivered" } },
    });
    store().replaceAll([send("a"), send("b", "old", "t2")]);
    expect(Object.keys(store().held)).toEqual(["t1"]);
  });
});
