import { describe, expect, it, vi } from "vitest";
import { forgetHostState } from "../forgetHostState.js";

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../utils/logger.js", () => ({ createLogger: () => logger }));

describe("forgetHostState", () => {
  it("runs every cleanup in order, past one that fails", async () => {
    logger.warn.mockClear();
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
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]![1]).toMatchObject({ hostId: "studio", cleanup: "second" });
  });
});
