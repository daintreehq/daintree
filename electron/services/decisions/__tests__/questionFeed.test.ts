import { describe, expect, it, vi } from "vitest";
import { MemoryLocalStore, type QuestionRow } from "@daintreehq/decisions-client";
import { QuestionRowsFeed, observeQuestionWrites } from "../questionFeed.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("observeQuestionWrites", () => {
  it("tells after a question write commits, not for reads or other writes", async () => {
    const store = new MemoryLocalStore();
    const onWrite = vi.fn();
    const observed = observeQuestionWrites(store, onWrite);

    await observed.setMeta("k", "v");
    expect(await observed.getMeta("k")).toBe("v");
    await observed.listQuestions();
    expect(onWrite).not.toHaveBeenCalled();

    expect(await observed.updateQuestion("q_missing", { local_status: "open" })).toBeNull();
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("tells nothing when the write fails", async () => {
    const store = new MemoryLocalStore();
    vi.spyOn(store, "updateQuestion").mockRejectedValue(new Error("disk full"));
    const onWrite = vi.fn();
    const observed = observeQuestionWrites(store, onWrite);
    await expect(observed.updateQuestion("q_1", { local_status: "open" })).rejects.toThrow(
      "disk full"
    );
    expect(onWrite).not.toHaveBeenCalled();
  });
});

describe("QuestionRowsFeed", () => {
  it("serves refreshes asked while a read is out with one more read", async () => {
    const reads: Array<ReturnType<typeof deferred<QuestionRow[]>>> = [];
    const applied: number[] = [];
    const feed = new QuestionRowsFeed(
      () => {
        const read = deferred<QuestionRow[]>();
        reads.push(read);
        return read.promise;
      },
      (rows) => applied.push(rows.length)
    );

    feed.refresh();
    feed.refresh();
    feed.refresh();
    expect(reads).toHaveLength(1);
    reads[0].resolve([]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1].resolve([{} as QuestionRow]);
    await vi.waitFor(() => expect(applied).toEqual([0, 1]));
    expect(reads).toHaveLength(2);
  });

  it("keeps going after a failed read, and feeds nothing once stopped", async () => {
    const reads: Array<ReturnType<typeof deferred<QuestionRow[]>>> = [];
    const apply = vi.fn();
    const feed = new QuestionRowsFeed(() => {
      const read = deferred<QuestionRow[]>();
      reads.push(read);
      return read.promise;
    }, apply);

    feed.refresh();
    reads[0].reject(new Error("locked"));
    await vi.waitFor(() => expect(apply).not.toHaveBeenCalled());
    feed.refresh();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    feed.stop();
    reads[1].resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    feed.refresh();
    expect(apply).not.toHaveBeenCalled();
    expect(reads).toHaveLength(2);
  });
});
