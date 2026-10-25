import { afterEach, describe, expect, it } from "vitest";
import {
  _resetHostStartedTerminalsForTesting,
  forgetHostStartedTerminals,
  hostStartedTerminals,
  noteHeldByView,
  noteHostStartedTerminal,
} from "../hostStartedTerminals.js";

const ids = (projectId: string) => hostStartedTerminals(projectId).map((t) => t.id);

describe("hostStartedTerminals (#14473)", () => {
  afterEach(() => _resetHostStartedTerminalsForTesting());

  it("keeps each project's own, and a placement only the spawn gave", () => {
    noteHostStartedTerminal("p1", "a", { location: "dock", worktreeId: "/repo" });
    noteHostStartedTerminal("p1", "b", { location: "overlay" });
    noteHostStartedTerminal("p2", "c", {});

    expect(hostStartedTerminals("p1")).toEqual([
      { id: "a", location: "dock", worktreeId: "/repo", heldBy: new Set() },
      { id: "b", location: "grid", heldBy: new Set() },
    ]);
    expect(ids("p2")).toEqual(["c"]);
  });

  it("past its bound, drops one a view already answers for before the oldest unheld", () => {
    for (let i = 0; i < 256; i++) noteHostStartedTerminal("p1", `t${i}`, {});
    noteHeldByView("p1", ["t100"], 7);

    noteHostStartedTerminal("p1", "next", {});
    expect(ids("p1")).not.toContain("t100");
    expect(ids("p1")).toContain("t0");

    noteHostStartedTerminal("p1", "after", {});
    expect(ids("p1")).not.toContain("t0");
    expect(ids("p1")).toHaveLength(256);
  });

  it("forgets what main closed, and the project once nothing is left", () => {
    noteHostStartedTerminal("p1", "a", {});
    noteHostStartedTerminal("p1", "b", {});

    forgetHostStartedTerminals("p1", ["a"]);
    expect(ids("p1")).toEqual(["b"]);

    forgetHostStartedTerminals("p1", ["b"]);
    noteHeldByView("p1", ["b"], 7);
    expect(hostStartedTerminals("p1")).toEqual([]);
  });
});
