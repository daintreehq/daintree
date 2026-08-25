import { describe, expect, it } from "vitest";
import {
  ProjectHistoryService,
  disposeProjectHistory,
  getProjectHistory,
  resetProjectHistory,
} from "../ProjectHistoryService.js";

const always = () => true;

// Real id shapes for the mixed-workspace case: a project is 64 hex characters,
// a scratch a UUIDv4, and the two spaces are disjoint.
const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const SCRATCH_ONE = "11111111-1111-4111-8111-111111111111";

function visit(history: ProjectHistoryService, ...workspaceIds: string[]): void {
  for (const workspaceId of workspaceIds) history.record(workspaceId);
}

/**
 * How a real switch folds in: the outgoing workspace is recorded before the
 * incoming one, exactly as the view-swap path does. Peeking in isolation would
 * miss whether the pair leaves the list able to answer the next press.
 */
function switchTo(history: ProjectHistoryService, workspaceId: string): void {
  const outgoing = history.current();
  if (outgoing) history.record(outgoing);
  history.record(workspaceId);
}

/** Press the toggle: resolve a target, then switch to it the way the app does. */
function pressToggle(history: ProjectHistoryService): string | null {
  const target = history.peekLast(always);
  if (target) switchTo(history, target);
  return target;
}

describe("ProjectHistoryService", () => {
  it("returns to where you started after two presses, from any depth", () => {
    // The property the shortcut exists for. A cursor that advanced on every
    // press had it only for two workspaces: from a third, two presses landed
    // somewhere new and the key stopped being pressable without looking.
    for (const depth of [2, 3, 5]) {
      const history = new ProjectHistoryService();
      const workspaces = Array.from({ length: depth }, (_, i) => `p${i}`);
      visit(history, ...workspaces);

      const origin = history.current();
      pressToggle(history);
      expect(history.current()).not.toBe(origin);
      pressToggle(history);

      expect(history.current()).toBe(origin);
    }
  });

  it("alternates between exactly two workspaces however long you keep pressing", () => {
    // The pair here is a scratch and a project. Nothing in the list tells them
    // apart — ids are opaque and the caller's `exists` predicate resolves them
    // — which is what lets a scratch hold a slot at all (#11936).
    const history = new ProjectHistoryService();
    visit(history, PROJECT_A, SCRATCH_ONE, PROJECT_B);

    const visited: string[] = [];
    for (let press = 0; press < 6; press++) {
      visited.push(pressToggle(history)!);
    }

    // The project is where we started, so the pair is project/scratch — never
    // drifting onto the one behind them.
    expect(visited).toEqual([
      SCRATCH_ONE,
      PROJECT_B,
      SCRATCH_ONE,
      PROJECT_B,
      SCRATCH_ONE,
      PROJECT_B,
    ]);
    // Toggling reorders but never grows.
    expect(new Set(history.snapshot().entries)).toEqual(
      new Set([PROJECT_A, SCRATCH_ONE, PROJECT_B])
    );
  });

  it("retargets the toggle after an unrelated switch", () => {
    // Going somewhere by other means — palette, menu, agent jump — has to
    // reseat the toggle, or it would still point at a workspace two switches
    // ago.
    const history = new ProjectHistoryService();
    visit(history, "a", "b");
    switchTo(history, "c");

    expect(history.peekLast(always)).toBe("b");
  });

  it("holds its invariants across a long mixed walk", () => {
    // Toggles interleaved with off-list jumps: the arrangement that previously
    // stranded navigation, since a workspace reachable two ways could end up
    // recorded twice and the second copy was indistinguishable from the first.
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c", "d", "e");

    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let move = 0; move < 200; move++) {
      if (rand() < 0.7) {
        pressToggle(history);
      } else {
        switchTo(history, `jump-${Math.floor(rand() * 4)}`);
      }

      const { entries } = history.snapshot();
      // A workspace recorded twice would make "the last workspace" ambiguous.
      expect(new Set(entries).size).toBe(entries.length);
      // Whatever we last switched to is where the window is.
      expect(entries[0]).toBe(history.current());
      // Uniqueness and a non-self target hold for any fixed offset into the
      // list, so they cannot tell the right target from a deeper one. Pin the
      // target to the entry immediately behind the head — the property two
      // presses actually depend on.
      expect(history.peekLast(always)).toBe(entries[1]);
    }
  });

  it("keeps its ordering and its toggle target at the size cap", () => {
    // Trimming and promotion meet only once the list is full, and only there
    // can promoting a deep entry interact with dropping the tail.
    const history = new ProjectHistoryService();
    for (let i = 0; i < 60; i++) history.record(`p${i}`);
    const full = history.snapshot().entries;
    const deep = full.at(-1)!;

    history.record(deep);
    const after = history.snapshot().entries;

    expect(after.length).toBe(full.length);
    expect(new Set(after)).toEqual(new Set(full));
    expect(after[0]).toBe(deep);
    // Promoting from the tail must leave the previous head one step behind, or
    // the toggle would skip it.
    expect(history.peekLast(always)).toBe(full[0]);
  });

  it("keeps a window's history separate from another window's, and drops it on close", () => {
    const first = getProjectHistory(1);
    expect(getProjectHistory(1)).toBe(first);

    visit(first, "a", "b");
    const second = getProjectHistory(2);
    visit(second, "c", "d");

    // A shared instance would let one window's toggle jump into a workspace the
    // other window visited.
    expect(second).not.toBe(first);
    expect(first.peekLast(always)).toBe("a");
    expect(second.peekLast(always)).toBe("c");

    disposeProjectHistory(1);

    // Window ids are recycled; inheriting the previous occupant's history would
    // point Back at workspaces this window never visited.
    expect(getProjectHistory(1).snapshot().entries).toEqual([]);
    expect(getProjectHistory(2).snapshot().entries).toEqual(second.snapshot().entries);

    disposeProjectHistory(2);
    resetProjectHistory(1);
    resetProjectHistory(2);
  });

  it("does not rebuild a history for a window that has already closed", () => {
    const history = getProjectHistory(3);
    visit(history, "a", "b");

    disposeProjectHistory(3);

    // Every record site runs after the view swap it is reporting, so a window
    // closed mid-switch records once more on its way out. That record must not
    // put an entry back that nothing will ever dispose again.
    getProjectHistory(3).record("c");

    expect(getProjectHistory(3).snapshot().entries).toEqual([]);
    expect(getProjectHistory(3).peekLast(always)).toBeNull();

    // And the id stays inert until a live window claims it, so the next window
    // handed this id can't inherit the dead one's destinations.
    resetProjectHistory(3);
    const recycled = getProjectHistory(3);
    recycled.record("d");
    expect(recycled.snapshot().entries).toEqual(["d"]);

    resetProjectHistory(3);
  });

  it("has nowhere to go from a window that has only seen one project", () => {
    const history = new ProjectHistoryService();
    visit(history, "a");

    expect(history.peekLast(always)).toBeNull();
    expect(history.current()).toBe("a");
  });

  it("ignores a redundant switch to the project already showing", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b");
    const before = history.snapshot();

    history.record("b");

    expect(history.snapshot()).toEqual(before);
  });

  it("promotes a revisited project instead of recording it twice", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c", "d");
    history.record("b");

    expect(history.snapshot().entries).toEqual(["b", "d", "c", "a"]);
  });

  it("demotes the toggle onto the next survivor when its target is removed", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "gone", "c");

    // Without pruning the toggle would resolve to a project that no longer
    // exists, and the press would silently do nothing.
    expect(history.peekLast((id) => id !== "gone")).toBe("a");
    expect(history.snapshot().entries).toEqual(["c", "a"]);
  });

  it("survives the project at its head being removed", () => {
    // Only reachable when the project the window is in is deleted under it.
    // Which of the survivors it then offers is arbitrary — what matters is that
    // it offers a real one rather than the deleted id or nothing at all.
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "gone");
    const exists = (id: string) => id !== "gone";

    const target = history.peekLast(exists);

    expect(target).not.toBeNull();
    expect(exists(target!)).toBe(true);
    // Which survivor it lands on is arbitrary, but pruning must not reshuffle:
    // recency order is the contract every other caller reads.
    expect(history.snapshot().entries).toEqual(["b", "a"]);
  });

  it("reports nowhere to go when only the current project survives", () => {
    const history = new ProjectHistoryService();
    visit(history, "gone", "c");

    expect(history.peekLast((id) => id !== "gone")).toBeNull();
    expect(history.current()).toBe("c");
  });

  it("reports the project the window is in", () => {
    const history = new ProjectHistoryService();
    expect(history.current()).toBeNull();

    visit(history, "a", "b");
    expect(history.current()).toBe("b");

    history.record("a");
    expect(history.current()).toBe("a");
  });

  it("stops growing while keeping the newest visits", () => {
    const shortRun = new ProjectHistoryService();
    for (let i = 0; i < 200; i++) shortRun.record(`p${i}`);
    const bounded = shortRun.snapshot().entries.length;

    const history = new ProjectHistoryService();
    for (let i = 0; i < 400; i++) history.record(`p${i}`);
    const { entries } = history.snapshot();

    // Twice the visits, same length — bounded, not proportional.
    expect(entries.length).toBe(bounded);
    expect(bounded).toBeLessThan(200);
    // Trimming happens at the far end, so the toggle still works after it.
    expect(entries[0]).toBe("p399");
    expect(entries[1]).toBe("p398");
    expect(entries).not.toContain("p0");
  });

  it("ignores an empty project id", () => {
    const history = new ProjectHistoryService();
    history.record("");

    expect(history.snapshot().entries).toEqual([]);
  });

  it("has nowhere to go from an empty history", () => {
    const history = new ProjectHistoryService();

    expect(history.peekLast(always)).toBeNull();
    expect(history.current()).toBeNull();
  });
});
