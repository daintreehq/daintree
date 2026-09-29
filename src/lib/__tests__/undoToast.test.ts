import { describe, expect, it } from "vitest";
import { positionOf, reinsert, type RemovedPosition } from "../undoToast";

type Item = { id: string };
const items = (ids: string) => ids.split("").map((id) => ({ id }));
const ids = (list: Item[]) => list.map((i) => i.id).join("");

describe("reinsert", () => {
  // Every pair of removals, undone in either order, lands back exactly where it
  // was — including the head, the tail and adjacent pairs.
  const original = items("abcde");
  for (const first of original) {
    for (const second of original) {
      if (first === second) continue;
      it(`restores ${first.id} and ${second.id} in either undo order`, () => {
        for (const undoFirst of [first, second]) {
          let list = [...original];
          const positions = new Map<string, RemovedPosition>();
          for (const gone of [first, second]) {
            positions.set(gone.id, positionOf(list, gone.id));
            list = list.filter((i) => i.id !== gone.id);
          }
          const undoSecond = undoFirst === first ? second : first;
          for (const back of [undoFirst, undoSecond]) {
            list = reinsert(list, back, positions.get(back.id)!);
          }
          expect(ids(list)).toBe(ids(original));
        }
      });
    }
  }

  it("keeps an item added since the removal", () => {
    const position = positionOf(items("abc"), "b");
    const list = reinsert(items("acx"), { id: "b" }, position);
    expect(ids(list)).toBe("abcx");
  });

  it("is a no-op when the item is already back", () => {
    expect(ids(reinsert(items("abc"), { id: "b" }, positionOf(items("abc"), "b")))).toBe("abc");
  });
});
