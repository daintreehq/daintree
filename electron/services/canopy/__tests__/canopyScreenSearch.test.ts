import { describe, expect, it, vi } from "vitest";
import { searchScreens } from "../canopyScreenSearch.js";

const target = (runId: string, terms: string[]) => ({ runId, spawnedAt: 1, terms });

describe("searchScreens", () => {
  it("returns the runs whose screen holds every term, ignoring case", async () => {
    const screens: Record<string, string | null> = {
      a: "npm ERR! ECONNRESET while fetching",
      b: "All tests passed",
      c: null,
    };
    const found = await searchScreens(
      [target("a", ["econnreset", "fetching"]), target("b", ["econnreset"]), target("c", ["x"])],
      async ({ runId }) => screens[runId] ?? null
    );
    expect(found).toEqual(["a"]);
  });

  it("needs all of a run's terms, not any", async () => {
    const found = await searchScreens([target("a", ["passed", "failed"])], async () => "passed");
    expect(found).toEqual([]);
  });

  it("matches a run holding every word of any one alternative", async () => {
    const screens: Record<string, string> = {
      a: "Review of dfat-xth8 done",
      b: "fallback-review: dfat-vjv0 waiting",
      c: "fallback-review: something else",
    };
    const ask = (runId: string) => ({
      ...target(runId, ["dfat-xth8"]),
      orTerms: [["cocto-claude"], ["fallback-review:", "dfat-vjv0"]],
    });
    const read = vi.fn(async ({ runId }: { runId: string }) => screens[runId] ?? null);
    const found = await searchScreens([ask("a"), ask("b"), ask("c")], read);
    expect(found).toEqual(["a", "b"]);
    // Each run's screen is read once, however many alternatives it is asked for.
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("skips an empty alternative rather than letting it match everything", async () => {
    const found = await searchScreens(
      [{ ...target("a", ["missing"]), orTerms: [[], [""]] }],
      async () => "anything at all"
    );
    expect(found).toEqual([]);
  });

  it("treats a failed read as no match, and still answers for the rest", async () => {
    const found = await searchScreens(
      [target("a", ["ok"]), target("b", ["ok"])],
      async ({ runId }) => {
        if (runId === "a") throw new Error("gone");
        return "ok";
      }
    );
    expect(found).toEqual(["b"]);
  });

  it("reads a run named twice once", async () => {
    const read = vi.fn(async () => "ok");
    const found = await searchScreens([target("a", ["ok"]), target("a", ["ok"])], read);
    expect(found).toEqual(["a"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("holds overlapping searches to the same few reads as one", async () => {
    let inFlight = 0;
    let most = 0;
    const read = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return "match";
    };
    const batch = (prefix: string) =>
      Array.from({ length: 20 }, (_, index) => target(`${prefix}${index}`, ["match"]));
    await searchScreens(batch("one"), read);
    const alone = most;
    most = 0;
    const [first, second] = await Promise.all([
      searchScreens(batch("a"), read),
      searchScreens(batch("b"), read),
    ]);
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(20);
    expect(alone).toBeGreaterThan(1);
    expect(alone).toBeLessThan(20);
    expect(most).toBe(alone);
  });
});
