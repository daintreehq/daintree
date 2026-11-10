// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/hostResyncSignal", () => ({ onHostResync: () => () => {} }));
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn }));

import { isCanopySizeHeld, subscribeCanopySizeHolds, takeCanopySize } from "../canopySizeHolds";

describe("takeCanopySize (#16333)", () => {
  let push: (terminalIds: string[]) => void = () => {};
  let unsubscribe: () => void = () => {};
  const takeTerminalSize = vi.fn(async (_terminalId: string) => {});

  beforeEach(() => {
    takeTerminalSize.mockReset();
    takeTerminalSize.mockResolvedValue(undefined);
    logWarn.mockClear();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        canopy: { getSizeHolds: async () => [], takeTerminalSize },
        events: {
          on: (_name: string, listener: (ids: string[]) => void) => {
            push = listener;
            return () => {};
          },
        },
      },
    });
    unsubscribe = subscribeCanopySizeHolds(() => {});
  });

  afterEach(() => unsubscribe());

  it("asks nothing for a terminal no panel holds", () => {
    push(["t1"]);
    takeCanopySize("t2");
    expect(takeTerminalSize).not.toHaveBeenCalled();
  });

  it("asks once per hold, so a hold that stands doesn't cost every keystroke a call", () => {
    push(["t1"]);
    expect(isCanopySizeHeld("t1")).toBe(true);
    takeCanopySize("t1");
    takeCanopySize("t1");
    expect(takeTerminalSize.mock.calls).toEqual([["t1"]]);
  });

  it("asks again once the list has moved", () => {
    push(["t1"]);
    takeCanopySize("t1");
    push([]);
    push(["t1"]);
    takeCanopySize("t1");
    expect(takeTerminalSize).toHaveBeenCalledTimes(2);
  });

  it("says when the host refused, and asks again on the next interaction", async () => {
    takeTerminalSize.mockRejectedValueOnce(new Error("rate limited"));
    push(["t1"]);
    takeCanopySize("t1");
    await vi.waitFor(() => expect(logWarn).toHaveBeenCalledTimes(1));
    expect(isCanopySizeHeld("t1")).toBe(true);

    takeCanopySize("t1");
    expect(takeTerminalSize).toHaveBeenCalledTimes(2);
  });
});
