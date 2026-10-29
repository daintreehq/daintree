import { describe, expect, it } from "vitest";
import { describeAttachedMachines } from "../attachedMachines.js";

describe("describeAttachedMachines", () => {
  it("names one machine in the singular", () => {
    expect(describeAttachedMachines(["MacBook Pro"])).toEqual({
      count: 1,
      subject: "MacBook Pro",
      object: "MacBook Pro",
      verb: "is",
      pronoun: "it",
      openWork: "the work it has open",
    });
  });

  it("counts machines that share a name instead of merging them", () => {
    const copy = describeAttachedMachines(["MacBook Pro", "MacBook Pro"]);
    expect(copy.count).toBe(2);
    expect(copy.object).toBe("2 machines named MacBook Pro");
    expect(copy.verb).toBe("are");
    expect(copy.openWork).toBe("the work they have open");
  });

  it("joins different names as a list", () => {
    expect(describeAttachedMachines(["MacBook Pro", "Studio"]).object).toBe(
      "MacBook Pro and Studio"
    );
    expect(describeAttachedMachines(["A", "B", "C"]).object).toBe("A, B, and C");
  });

  it("says another machine for an unnamed one, capitalised only at the start", () => {
    const alone = describeAttachedMachines([" "]);
    expect(alone.subject).toBe("Another machine");
    expect(alone.object).toBe("another machine");
    expect(alone.verb).toBe("is");

    const after = describeAttachedMachines(["MacBook Pro", ""]);
    expect(after.subject).toBe("MacBook Pro and another machine");
    expect(after.verb).toBe("are");
  });

  it("counts several unnamed machines", () => {
    expect(describeAttachedMachines(["", " "]).subject).toBe("2 machines");
    expect(describeAttachedMachines(["Studio", "", ""]).object).toBe("Studio and 2 other machines");
  });

  it("keeps a lowercase machine name as it is", () => {
    expect(describeAttachedMachines(["greg-mbp"]).subject).toBe("greg-mbp");
  });
});
