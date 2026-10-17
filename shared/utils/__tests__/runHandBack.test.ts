import { describe, it, expect } from "vitest";
import { isHandBackStop, isHandBackUnseen } from "../runHandBack.js";

describe("isHandBackUnseen", () => {
  it("is false without a hand-back", () => {
    expect(isHandBackUnseen(undefined)).toBe(false);
  });

  it("is unseen until seen, and again once marked unread", () => {
    expect(isHandBackUnseen({ stoppedAt: 1 })).toBe(true);
    expect(isHandBackUnseen({ stoppedAt: 1, seenAt: 2 })).toBe(false);
    expect(isHandBackUnseen({ stoppedAt: 1, seenAt: 2, markedUnreadAt: 3 })).toBe(true);
  });
});

describe("isHandBackStop", () => {
  it("counts a completion and a generic prompt wait", () => {
    expect(isHandBackStop("completed")).toBe(true);
    expect(isHandBackStop("waiting")).toBe(true);
    expect(isHandBackStop("waiting", "prompt")).toBe(true);
  });

  it("never counts an ask, an error, or a run not stopped on work", () => {
    expect(isHandBackStop("waiting", "approval")).toBe(false);
    expect(isHandBackStop("waiting", "question")).toBe(false);
    expect(isHandBackStop("waiting", "error")).toBe(false);
    expect(isHandBackStop("idle")).toBe(false);
    expect(isHandBackStop("exited")).toBe(false);
    expect(isHandBackStop("working")).toBe(false);
  });
});
