import { describe, it, expect } from "vitest";
import { nextDuplicateName } from "../recipeDuplicate";

describe("nextDuplicateName", () => {
  it("returns 'Foo (Copy)' when no copies exist yet", () => {
    expect(nextDuplicateName("Foo", new Set())).toBe("Foo (Copy)");
  });

  it("strips existing '(Copy)' suffix so duplicating a copy doesn't nest", () => {
    expect(nextDuplicateName("Foo (Copy)", new Set(["Foo (Copy)"]))).toBe("Foo (Copy 2)");
  });

  it("strips existing '(Copy N)' suffix and increments past the highest taken slot", () => {
    const taken = new Set(["Foo (Copy)", "Foo (Copy 2)"]);
    expect(nextDuplicateName("Foo (Copy 2)", taken)).toBe("Foo (Copy 3)");
  });

  it("never returns a name that is already taken", () => {
    const taken = new Set(["Recipe", "Recipe (Copy)"]);
    const result = nextDuplicateName("Recipe", taken);
    expect(taken.has(result)).toBe(false);
    expect(result).toBe("Recipe (Copy 2)");
  });

  it("pre-truncates very long names so copies don't collide on the on-disk filename", () => {
    // Without root pre-truncation, " (Copy)" gets sliced off by safeRecipeFilename's
    // 200-char cap and every candidate would map to the same filename on disk.
    const longName = "a".repeat(220);
    const result = nextDuplicateName(longName, new Set([longName]));
    expect(result).not.toBe(longName);
    expect(result.length).toBeLessThanOrEqual(180 + " (Copy)".length);
  });
});
