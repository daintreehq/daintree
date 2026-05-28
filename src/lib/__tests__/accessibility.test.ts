// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeAndAnnounce } from "../accessibility";
import {
  useAnnouncerStore,
  _resetAnnouncerDeliveryForTests,
} from "@/store/accessibilityAnnouncerStore";

interface DocumentWithAriaNotify extends Document {
  ariaNotify?: (message: string, options?: { priority?: "normal" | "high" }) => void;
}

describe("closeAndAnnounce", () => {
  let ariaNotifyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    _resetAnnouncerDeliveryForTests();
    ariaNotifyMock = vi.fn();
    (document as DocumentWithAriaNotify).ariaNotify =
      ariaNotifyMock as unknown as DocumentWithAriaNotify["ariaNotify"];
  });

  afterEach(() => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
  });

  it("closes before announcing so focus returns to the main tree first", () => {
    const calls: string[] = [];
    const closeFn = vi.fn(() => calls.push("close"));
    ariaNotifyMock.mockImplementation(() => calls.push("announce"));

    closeAndAnnounce(closeFn, "Terminal killed");

    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(ariaNotifyMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["close", "announce"]);
  });

  it("forwards a polite priority as ariaNotify 'normal'", () => {
    closeAndAnnounce(() => {}, "Saved", "polite");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Saved", { priority: "normal" });
  });

  it("forwards an assertive priority as ariaNotify 'high'", () => {
    closeAndAnnounce(() => {}, "Failure", "assertive");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Failure", { priority: "high" });
  });

  it("defaults to polite ('normal') when priority is omitted", () => {
    closeAndAnnounce(() => {}, "Closed");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Closed", { priority: "normal" });
  });

  it("forwards an empty message unchanged", () => {
    closeAndAnnounce(() => {}, "");
    expect(ariaNotifyMock).toHaveBeenCalledWith("", { priority: "normal" });
  });

  it("does not announce when closeFn throws", () => {
    const boom = vi.fn(() => {
      throw new Error("close failed");
    });
    expect(() => closeAndAnnounce(boom, "Should not fire")).toThrow("close failed");
    expect(ariaNotifyMock).not.toHaveBeenCalled();
  });

  it("routes through the store DOM fallback when ariaNotify is unavailable", () => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
    closeAndAnnounce(() => {}, "Trashed all sessions");
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Trashed all sessions");
  });

  it("closes before mutating the store on the DOM fallback path too", () => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
    let storeWasEmptyAtCloseTime = false;
    const closeFn = vi.fn(() => {
      storeWasEmptyAtCloseTime = useAnnouncerStore.getState().polite === null;
    });

    closeAndAnnounce(closeFn, "Terminal killed");

    // The store must still be empty at the moment closeFn ran — the
    // announcement is only written after the modal closes.
    expect(storeWasEmptyAtCloseTime).toBe(true);
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Terminal killed");
  });
});
