import { describe, expect, it } from "vitest";
import { attributeClose } from "../closeAttribution.js";

describe("attributeClose", () => {
  const trashed = { id: "t1", spawnedAt: 1_000, isTrashed: true, trashExpiresAt: 41_000 };

  it.each(["kill", "shutdown", "sleep", "restart"] as const)(
    "calls a %s of a pane in the trash the user's close, naming that trash",
    (cause) => {
      expect(attributeClose(trashed, cause, 20_000)).toEqual({
        closedBy: "user",
        trash: { terminalId: "t1", spawnedAt: 1_000, expiresAt: 41_000, closedAt: 21_000 },
      });
    }
  );

  it.each(["kill", "shutdown", "sleep", "restart"] as const)(
    "keeps a %s of a pane outside the trash as its own cause",
    (cause) => {
      expect(attributeClose({ ...trashed, isTrashed: false }, cause, 20_000)).toEqual({
        closedBy: cause,
      });
    }
  );

  it("needs the trash and the incarnation to call it a user close", () => {
    expect(attributeClose({ ...trashed, trashExpiresAt: undefined }, "kill", 20_000)).toEqual({
      closedBy: "kill",
    });
    expect(attributeClose({ ...trashed, spawnedAt: undefined }, "kill", 20_000)).toEqual({
      closedBy: "kill",
    });
    expect(attributeClose(null, "shutdown", 20_000)).toEqual({ closedBy: "shutdown" });
  });
});
