import { afterEach, describe, expect, it } from "vitest";
import {
  cancelRecipeRunConfirmations,
  requestRecipeRunConfirmation,
  resolveRecipeRunConfirmation,
  useRecipeRunConfirmStore,
} from "../recipeRunConfirmStore";

const current = () => useRecipeRunConfirmStore.getState().current;

afterEach(() => cancelRecipeRunConfirmations());

describe("recipeRunConfirmStore (#15022)", () => {
  it("asks one at a time and promotes the next once the first is answered", async () => {
    const first = requestRecipeRunConfirmation({ recipeName: "A", missing: ["issue_number"] });
    const second = requestRecipeRunConfirmation({ recipeName: "B", missing: ["pr_number"] });

    expect(current()?.recipeName).toBe("A");
    resolveRecipeRunConfirmation(current()!.requestId, true);
    expect(current()?.recipeName).toBe("B");
    resolveRecipeRunConfirmation(current()!.requestId, false);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(current()).toBeNull();
  });

  it("ignores an answer for a request that has already been settled", async () => {
    const first = requestRecipeRunConfirmation({ recipeName: "A", missing: ["issue_number"] });
    const second = requestRecipeRunConfirmation({ recipeName: "B", missing: ["pr_number"] });
    const firstId = current()!.requestId;

    resolveRecipeRunConfirmation(firstId, false);
    // A late close from A's dialog must not answer B, now in its place.
    resolveRecipeRunConfirmation(firstId, true);

    await expect(first).resolves.toBe(false);
    expect(current()?.recipeName).toBe("B");
    resolveRecipeRunConfirmation(current()!.requestId, true);
    await expect(second).resolves.toBe(true);
  });

  it("declines when its signal aborts, whether it is being asked or still queued", async () => {
    const asking = new AbortController();
    const queued = new AbortController();
    const first = requestRecipeRunConfirmation(
      { recipeName: "A", missing: ["issue_number"] },
      asking.signal
    );
    const second = requestRecipeRunConfirmation(
      { recipeName: "B", missing: ["pr_number"] },
      queued.signal
    );
    const third = requestRecipeRunConfirmation({ recipeName: "C", missing: ["number"] });

    queued.abort();
    expect(useRecipeRunConfirmStore.getState().queue.map((item) => item.recipeName)).toEqual([
      "C",
    ]);
    asking.abort();
    expect(current()?.recipeName).toBe("C");

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    resolveRecipeRunConfirmation(current()!.requestId, true);
    await expect(third).resolves.toBe(true);
  });

  it("declines straight away for a signal that has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestRecipeRunConfirmation({ recipeName: "A", missing: ["issue_number"] }, controller.signal)
    ).resolves.toBe(false);
    expect(current()).toBeNull();
  });

  it("declines everything pending when the dialog can't render", async () => {
    const first = requestRecipeRunConfirmation({ recipeName: "A", missing: ["issue_number"] });
    const second = requestRecipeRunConfirmation({ recipeName: "B", missing: ["pr_number"] });

    cancelRecipeRunConfirmations();

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(useRecipeRunConfirmStore.getState()).toMatchObject({ current: null, queue: [] });
  });
});
