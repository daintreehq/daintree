import { describe, expect, it } from "vitest";
import { ProjectHistoryService } from "../ProjectHistoryService.js";

const always = () => true;

function visit(history: ProjectHistoryService, ...projectIds: string[]): void {
  for (const projectId of projectIds) history.record(projectId);
}

describe("ProjectHistoryService", () => {
  it("walks back further than two projects", () => {
    // The defect this replaces: recency-based switching bounced between the two
    // most recent projects forever, so a third was unreachable.
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c");

    expect(history.peek("back", always)).toBe("b");
    history.record("b");
    expect(history.peek("back", always)).toBe("a");
    history.record("a");
    // Past the oldest entry the ring comes round rather than dead-ending.
    expect(history.peek("back", always)).toBe("c");
  });

  it("alternates between two projects on repeated back presses", () => {
    // The behaviour people actually use, and the one the pre-stack shortcut
    // had. Losing it to strict browser semantics would have been a downgrade
    // for the common case in exchange for depth nobody asked for.
    const history = new ProjectHistoryService();
    visit(history, "a", "b");

    const visited: string[] = [];
    for (let press = 0; press < 4; press++) {
      const target = history.peek("back", always);
      expect(target).not.toBeNull();
      history.record(target!);
      visited.push(target!);
    }

    expect(visited).toEqual(["a", "b", "a", "b"]);
    // Alternating must not grow or rewrite the ring.
    expect(history.snapshot().entries).toEqual(["a", "b"]);
  });

  it("cycles through three projects without stranding the cursor", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c");

    const visited: string[] = [];
    for (let press = 0; press < 6; press++) {
      const target = history.peek("back", always)!;
      history.record(target);
      visited.push(target);
    }

    expect(visited).toEqual(["b", "a", "c", "b", "a", "c"]);
    expect(history.snapshot().entries).toEqual(["a", "b", "c"]);
  });

  it("goes nowhere when the ring holds only the current project", () => {
    const history = new ProjectHistoryService();
    visit(history, "a");

    // Wrapping onto yourself is not a step; the caller treats it as a no-op.
    expect(history.peek("back", always)).toBe("a");
    expect(history.current()).toBe("a");
  });

  it("offers forward to the entry ahead of the cursor", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c");
    history.record("b");

    expect(history.peek("forward", always)).toBe("c");
  });

  it("moves the cursor rather than growing when a step lands on a neighbour", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c");
    history.record("b");
    history.record("a");

    // Three visits, three entries — walking back must not append.
    expect(history.snapshot()).toEqual({ entries: ["a", "b", "c"], cursor: 0 });
  });

  it("discards the forward branch when the user jumps somewhere new", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c");
    history.record("b");
    history.record("d");

    expect(history.snapshot()).toEqual({ entries: ["a", "b", "d"], cursor: 2 });
    expect(history.peek("back", always)).toBe("b");
  });

  it("ignores a redundant switch to the project already showing", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b");
    history.record("b");

    expect(history.snapshot()).toEqual({ entries: ["a", "b"], cursor: 1 });
  });

  it("does not mistake a repeat visit for a step onto an identical neighbour", () => {
    // a → b → a leaves the cursor on the first entry. Recording "a" again is a
    // no-op, not a step backwards off the start of the stack.
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "a");
    expect(history.snapshot().cursor).toBe(0);

    history.record("a");
    expect(history.snapshot()).toEqual({ entries: ["a", "b"], cursor: 0 });
  });

  it("toggles cleanly between two projects without growing", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "a", "b", "a", "b");

    expect(history.snapshot()).toEqual({ entries: ["a", "b"], cursor: 1 });
  });

  it("completes the round trip a real navigation makes", () => {
    // peek → switch → record is how every step actually runs. Testing peek in
    // isolation misses the case where the target peek chose is one the cursor
    // cannot reach, which would branch instead of stepping.
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "c");

    for (let step = 0; step < 2; step++) {
      const target = history.peek("back", always);
      expect(target).not.toBeNull();
      history.record(target!);
    }

    expect(history.snapshot()).toEqual({ entries: ["a", "b", "c"], cursor: 0 });
    expect(history.peek("forward", always)).toBe("b");
  });

  it("steps cleanly past a removed project instead of branching", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "gone", "c");
    const exists = (id: string) => id !== "gone";

    const target = history.peek("back", exists);
    expect(target).toBe("a");
    history.record(target!);

    // The removed entry is pruned, so "a" is genuinely adjacent by the time the
    // switch lands. Skipping over it instead would leave the cursor stranded
    // and forward unavailable.
    expect(history.snapshot()).toEqual({ entries: ["a", "c"], cursor: 0 });
    expect(history.peek("forward", exists)).toBe("c");
  });

  it("collapses duplicates a removal exposes", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "gone", "a", "b");

    // Pruning "gone" would otherwise leave [a, a, b], where the neighbour of
    // the first "a" is another "a" and stepping goes nowhere visible.
    const target = history.peek("back", (id) => id !== "gone");

    expect(history.snapshot().entries).toEqual(["a", "b"]);
    expect(target).toBe("a");
  });

  it("keeps the cursor addressable when its own project is removed", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "b", "gone");

    history.peek("back", (id) => id !== "gone");
    const snapshot = history.snapshot();

    expect(snapshot.entries).toEqual(["a", "b"]);
    expect(snapshot.cursor).toBeGreaterThanOrEqual(0);
    expect(snapshot.cursor).toBeLessThan(snapshot.entries.length);
  });

  it("reports the project the cursor is on", () => {
    const history = new ProjectHistoryService();
    expect(history.current()).toBeNull();

    visit(history, "a", "b");
    expect(history.current()).toBe("b");

    history.record("a");
    expect(history.current()).toBe("a");
  });

  it("skips entries whose project has been removed", () => {
    const history = new ProjectHistoryService();
    visit(history, "a", "gone", "c");

    const exists = (id: string) => id !== "gone";
    // A removed project must not become a dead end that eats every press.
    expect(history.peek("back", exists)).toBe("a");
  });

  it("reports nowhere to go when only the current project survives", () => {
    const history = new ProjectHistoryService();
    visit(history, "gone", "c");

    // Pruning leaves a single entry, so the ring wraps onto the project already
    // showing — the caller reads that as nothing to do.
    expect(history.peek("back", (id) => id !== "gone")).toBe("c");
  });

  it("stops growing while keeping the newest entries and a valid cursor", () => {
    const shortRun = new ProjectHistoryService();
    for (let i = 0; i < 200; i++) shortRun.record(`p${i}`);
    const bounded = shortRun.snapshot().entries.length;

    const history = new ProjectHistoryService();
    for (let i = 0; i < 400; i++) history.record(`p${i}`);
    const snapshot = history.snapshot();

    // Twice the visits, same length — the stack is bounded, not proportional.
    expect(snapshot.entries.length).toBe(bounded);
    expect(bounded).toBeLessThan(200);
    // Trimming happens at the old end, so the newest visit survives and the
    // cursor still addresses it.
    expect(snapshot.entries.at(-1)).toBe("p399");
    expect(snapshot.cursor).toBe(snapshot.entries.length - 1);
    expect(snapshot.entries).not.toContain("p0");
  });

  it("ignores an empty project id", () => {
    const history = new ProjectHistoryService();
    history.record("");

    expect(history.snapshot()).toEqual({ entries: [], cursor: -1 });
  });

  it("has nowhere to go from an empty history", () => {
    const history = new ProjectHistoryService();

    expect(history.peek("back", always)).toBeNull();
    expect(history.peek("forward", always)).toBeNull();
    expect(history.canGo("back", always)).toBe(false);
  });
});
