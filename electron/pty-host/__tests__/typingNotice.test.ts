import { describe, expect, it, vi } from "vitest";
import { createTypingNotifier } from "../typingNotice.js";

function notifier() {
  const sendEvent = vi.fn();
  return { note: createTypingNotifier(sendEvent), sendEvent };
}

describe("createTypingNotifier", () => {
  it("reports Return and the keys that answer an approval menu", () => {
    const { note, sendEvent } = notifier();
    note("t1", "\r");
    note("t1", "1");
    note("t2", "\x1b");
    expect(sendEvent.mock.calls).toEqual([
      [{ type: "terminal-input", id: "t1", answer: "submit" }],
      [{ type: "terminal-input", id: "t1", answer: "key" }],
      [{ type: "terminal-input", id: "t2", answer: "key" }],
    ]);
  });

  it("reports nothing for typing, menu movement or the terminal's own reports", () => {
    const { note, sendEvent } = notifier();
    for (const data of ["hello", "\x1b[B", "\t", "\x1b[I", "\x1b[3;7R", "\x1b_Gi=1;OK\x1b\\"]) {
      note("t1", data);
    }
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
