import { describe, it, expect } from "vitest";
import { storedFallbacksFor } from "../scopeUtils";

describe("storedFallbacksFor (#16587)", () => {
  it("reads the saved list of the custom entry the merge keeps", () => {
    const saved = ["a", "b", "c"];
    expect(
      storedFallbacksFor(
        [
          // A nameless entry is rejected by the merge, so the next one with this id wins.
          { id: "p", name: "", fallbacks: ["x"] },
          { id: "p", name: "Kept", fallbacks: saved },
          { id: "q", name: "Other", fallbacks: ["y"] },
        ],
        "p"
      )
    ).toBe(saved);
  });

  it("has nothing to read when no custom entry with the id survives the merge", () => {
    expect(storedFallbacksFor([{ id: "p", name: " ", fallbacks: ["x"] }], "p")).toBeUndefined();
    expect(storedFallbacksFor(undefined, "p")).toBeUndefined();
  });
});
