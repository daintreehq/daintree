import { describe, expect, it } from "vitest";
import { settlePassageReplies } from "../voiceCorrectionPassages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Reply = { text: string; timing: unknown };

describe("settlePassageReplies", () => {
  it("keeps the passages in order and main's timing from the last reply back", async () => {
    const first = deferred<Reply>();
    const second = deferred<Reply>();
    const settled = settlePassageReplies([first.promise, second.promise]);

    second.resolve({ text: "B", timing: { prepMs: 5, requestMs: 900 } });
    await Promise.resolve();
    first.resolve({ text: "A", timing: { prepMs: 8, requestMs: 1_400 } });

    const { results, lastTiming } = await settled;
    expect(results.map((result) => result.text)).toEqual(["A", "B"]);
    expect(lastTiming).toEqual({ prepMs: 8, requestMs: 1_400 });
  });

  it("takes a last reply that carries no timing over an earlier one that did", async () => {
    const first = deferred<Reply>();
    const second = deferred<Reply>();
    const settled = settlePassageReplies([first.promise, second.promise]);

    first.resolve({ text: "A", timing: { prepMs: 8, requestMs: 1_400 } });
    await Promise.resolve();
    second.resolve({ text: "B", timing: null });

    expect((await settled).lastTiming).toBeNull();
  });
});
