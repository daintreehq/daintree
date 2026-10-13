import { describe, expect, it, vi } from "vitest";
import { forgetHostState } from "../forgetHostState.js";

describe("forgetHostState", () => {
  it("runs every cleanup in order, past one that fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ran: string[] = [];
    await forgetHostState("studio", [
      { name: "first", run: (hostId) => void ran.push(`first:${hostId}`) },
      {
        name: "second",
        run: async () => {
          ran.push("second");
          throw new Error("disk gone");
        },
      },
      {
        name: "third",
        run: () => {
          ran.push("third");
          throw new Error("sync failure");
        },
      },
      { name: "fourth", run: async () => void ran.push("fourth") },
    ]);
    expect(ran).toEqual(["first:studio", "second", "third", "fourth"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain("second");
    warn.mockRestore();
  });
});
