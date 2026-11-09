// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refocusStartAfterCancel } from "../refocusStartAfterCancel";

describe("refocusStartAfterCancel (#16603)", () => {
  let cancel: HTMLButtonElement;
  let start: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    cancel = document.createElement("button");
    start = document.createElement("button");
    document.body.append(cancel, start);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  /** Cancel pressed, the launch stopped, and Cancel gone with the launching state. */
  async function pressCancel(ringed: boolean, target: () => HTMLElement | null = () => start) {
    cancel.focus();
    vi.spyOn(cancel, "matches").mockImplementation((selector) => {
      if (selector === ":focus-visible") return ringed;
      return Element.prototype.matches.call(cancel, selector);
    });
    const focus = vi.spyOn(start, "focus");
    refocusStartAfterCancel(async () => {}, target);
    cancel.remove();
    await vi.advanceTimersByTimeAsync(50);
    return focus;
  }

  it("rings Start only when Cancel was pressed from the keyboard", async () => {
    const byKeyboard = await pressCancel(true);
    expect(document.activeElement).toBe(start);
    expect(byKeyboard).toHaveBeenCalledWith({ preventScroll: true, focusVisible: true });

    start.blur();
    document.body.append(cancel);
    const byPointer = await pressCancel(false);
    expect(byPointer).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("waits a frame or two for Start to appear", async () => {
    let shown: HTMLElement | null = null;
    cancel.focus();
    refocusStartAfterCancel(
      async () => {},
      () => shown
    );
    cancel.remove();
    await vi.advanceTimersByTimeAsync(40);
    expect(document.activeElement).toBe(document.body);
    shown = start;
    await vi.advanceTimersByTimeAsync(40);
    expect(document.activeElement).toBe(start);
  });

  it("lets go once Start has had its frames, or something else took the keyboard", async () => {
    let shown: HTMLElement | null = null;
    cancel.focus();
    refocusStartAfterCancel(
      async () => {},
      () => shown
    );
    cancel.remove();
    await vi.advanceTimersByTimeAsync(1_000);
    shown = start;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(document.activeElement).toBe(document.body);

    const elsewhere = document.createElement("input");
    document.body.append(cancel, elsewhere);
    cancel.focus();
    refocusStartAfterCancel(
      async () => {},
      () => start
    );
    elsewhere.focus();
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).toBe(elsewhere);
  });
});
