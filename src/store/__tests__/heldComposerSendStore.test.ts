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

  it.each([{ kind: "delivered" as const }, { kind: "withdrawn" as const }])(
    "forgets a $kind send without a note",
    (outcome) => {
      store().applyChange({ terminalId: "t1", held: send("a") });
      store().applyChange({ terminalId: "t1", held: null, ended: { token: "a", outcome } });
      expect(store().held).toEqual({});
      expect(store().dropped).toEqual({});
    }
  );

  it("keeps a drop's text from the push when this view never saw it held", () => {
    store().applyChange({
      terminalId: "t1",
      held: null,
      ended: {
        token: "a",
        outcome: { kind: "dropped", reason: "ended" },
        text: "from main",
        imagePaths: ["/tmp/a.png"],
      },
    });
    expect(store().dropped.t1).toEqual({
      token: "a",
      text: "from main",
      imagePaths: ["/tmp/a.png"],
      reason: "ended",
    });
  });

  it("forgets drop notes for panes the view no longer has", () => {
    for (const id of ["t1", "t2"]) {
      store().applyChange({
        terminalId: id,
        held: null,
        ended: { token: id, outcome: { kind: "dropped", reason: "closed" }, text: "x" },
      });
    }
    store().forgetDroppedExcept(new Set(["t2"]));
    expect(Object.keys(store().dropped)).toEqual(["t2"]);
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
    expect(store().refused).toEqual({});
    store().noteRefused("t1");
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
