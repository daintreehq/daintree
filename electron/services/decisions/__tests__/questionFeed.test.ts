import { describe, expect, it, vi } from "vitest";
import type { QuestionRow } from "@daintreehq/decisions-client";
import { QuestionRowsFeed, type QuestionRowsSource } from "../questionFeed.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const row = (id: string, alias: number, over: Partial<QuestionRow> = {}): QuestionRow =>
  ({ question_id: id, alias, local_status: "open", ...over }) as QuestionRow;

/** A source over `stored`, counting what each read asked for. */
function storeOf(stored: Map<string, QuestionRow>) {
  const reads: Array<"all" | string[]> = [];
  const source: QuestionRowsSource = {
    all: vi.fn(async () => {
      reads.push("all");
      return [...stored.values()].sort((a, b) => a.alias - b.alias);
    }),
    some: vi.fn(async (ids: readonly string[]) => {
      reads.push([...ids]);
      return ids.flatMap((id) => {
        const found = stored.get(id);
        return found ? [found] : [];
      });
    }),
  };
  return { source, reads };
}

const ids = (rows: readonly QuestionRow[]) => rows.map((r) => r.question_id);

describe("QuestionRowsFeed", () => {
  it("serves refreshes asked while a read is out with one more read of every question they named", async () => {
    const reads: Array<ReturnType<typeof deferred<QuestionRow[]>>> = [];
    const asked: string[][] = [];
    const applied: string[][] = [];
    const feed = new QuestionRowsFeed(
      {
        all: () => {
          const read = deferred<QuestionRow[]>();
          reads.push(read);
          return read.promise;
        },
        some: (ids) => {
          asked.push([...ids]);
          const read = deferred<QuestionRow[]>();
          reads.push(read);
          return read.promise;
        },
      },
      (rows) => applied.push(ids(rows))
    );

    void feed.refresh();
    void feed.refresh(["q1"]);
    void feed.refresh(["q2"]);
    expect(reads).toHaveLength(1);
    reads[0].resolve([]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(asked).toEqual([["q1", "q2"]]);
    reads[1].resolve([row("q1", 1), row("q2", 2)]);
    await vi.waitFor(() => expect(applied).toEqual([[], ["q1", "q2"]]));
    expect(reads).toHaveLength(2);
  });

  it("reads every row once, then only the questions each commit wrote", async () => {
    const stored = new Map(
      Array.from({ length: 1000 }, (_, i) => [
        `h${i}`,
        row(`h${i}`, i + 1, { local_status: "expired" }),
      ])
    );
    const { source, reads } = storeOf(stored);
    const applied: QuestionRow[][] = [];
    const feed = new QuestionRowsFeed(source, (rows) => applied.push([...rows]));

    await feed.refresh();
    expect(applied[0]).toHaveLength(1000);

    const asked = row("q-new", 1001);
    stored.set(asked.question_id, asked);
    await feed.refresh([asked.question_id]);
    const changed = row("h5", 6, { local_status: "cancelled" });
    stored.set("h5", changed);
    await feed.refresh(["h5"]);

    expect(reads).toEqual(["all", ["q-new"], ["h5"]]);
    const last = applied.at(-1)!;
    expect(last).toHaveLength(1001);
    expect(last.at(-1)).toBe(asked);
    expect(last[5]).toBe(changed);
    // The rows no commit named are the very objects the first read gave.
    expect(last[0]).toBe(applied[0][0]);
  });

  it("drops a question whose row is gone, and feeds what it holds for an empty change", async () => {
    const stored = new Map([
      ["a", row("a", 1)],
      ["b", row("b", 2)],
      ["c", row("c", 3)],
    ]);
    const { source, reads } = storeOf(stored);
    const applied: string[][] = [];
    const feed = new QuestionRowsFeed(source, (rows) => applied.push(ids(rows)));

    await feed.refresh();
    stored.delete("b");
    await feed.refresh(["b"]);
    await feed.refresh([]);

    expect(applied).toEqual([
      ["a", "b", "c"],
      ["a", "c"],
      ["a", "c"],
    ]);
    expect(reads).toEqual(["all", ["b"], []]);
  });

  it("keeps alias order when a question comes in under an older alias", async () => {
    // Ids sort the other way to aliases, so only an order by alias passes.
    const stored = new Map([
      ["z", row("z", 1)],
      ["x", row("x", 3)],
    ]);
    const { source } = storeOf(stored);
    const applied: string[][] = [];
    const feed = new QuestionRowsFeed(source, (rows) => applied.push(ids(rows)));

    await feed.refresh();
    stored.set("y", row("y", 2));
    await feed.refresh(["y"]);
    stored.set("w", row("w", 4));
    await feed.refresh(["w"]);

    expect(applied.slice(1)).toEqual([
      ["z", "y", "x"],
      ["z", "y", "x", "w"],
    ]);
  });

  it("reads a failed read's questions again with the next ask", async () => {
    const stored = new Map([["a", row("a", 1)]]);
    const { source, reads } = storeOf(stored);
    const applied: string[][] = [];
    const feed = new QuestionRowsFeed(source, (rows) => applied.push(ids(rows)));

    await feed.refresh();
    stored.set("b", row("b", 2));
    vi.mocked(source.some).mockRejectedValueOnce(new Error("busy"));
    await feed.refresh(["b"]);
    expect(applied).toHaveLength(1);

    stored.set("c", row("c", 3));
    await feed.refresh(["c"]);
    expect(applied.at(-1)).toEqual(["a", "b", "c"]);
    expect(reads.at(-1)).toEqual(["b", "c"]);
  });

  it("reads every row again after a failed first read", async () => {
    const stored = new Map([["a", row("a", 1)]]);
    const { source, reads } = storeOf(stored);
    const apply = vi.fn();
    const feed = new QuestionRowsFeed(source, apply);

    vi.mocked(source.all).mockRejectedValueOnce(new Error("locked"));
    await feed.refresh();
    expect(apply).not.toHaveBeenCalled();
    await feed.refresh(["a"]);
    expect(reads).toEqual(["all"]);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("feeds nothing once stopped", async () => {
    const reads: Array<ReturnType<typeof deferred<QuestionRow[]>>> = [];
    const apply = vi.fn();
    const read = () => {
      const next = deferred<QuestionRow[]>();
      reads.push(next);
      return next.promise;
    };
    const feed = new QuestionRowsFeed({ all: read, some: read }, apply);

    void feed.refresh();
    reads[0].reject(new Error("locked"));
    await vi.waitFor(() => expect(apply).not.toHaveBeenCalled());
    void feed.refresh();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    feed.stop();
    reads[1].resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    void feed.refresh();
    expect(apply).not.toHaveBeenCalled();
    expect(reads).toHaveLength(2);
  });
});
