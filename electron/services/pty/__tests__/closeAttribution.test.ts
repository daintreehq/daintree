import { describe, expect, it } from "vitest";
import { attributeClose } from "../closeAttribution.js";

describe("attributeClose", () => {
  const trashed = {
    id: "t1",
    spawnedAt: 1_000,
    isTrashed: true,
    trashExpiresAt: 41_000,
    titleMode: "user" as const,
    agentPresetColor: "#ff0000",
  };

  it.each(["kill", "shutdown", "sleep", "restart"] as const)(
    "calls a %s of a pane in the trash the user's close, naming that trash and how the pane looked",
    (cause) => {
      expect(attributeClose(trashed, cause, 20_000)).toEqual({
        closedBy: "user",
        terminal: { id: "t1", spawnedAt: 1_000 },
        trash: { expiresAt: 41_000, closedAt: 21_000, titleMode: "user", agentPresetColor: "#ff0000" },
      });
    }
  );

  it.each(["kill", "shutdown", "sleep", "restart", "bookmark"] as const)(
    "keeps a %s of a pane outside the trash as its own cause, naming the incarnation",
    (cause) => {
      expect(attributeClose({ ...trashed, isTrashed: false }, cause, 20_000)).toEqual({
        closedBy: cause,
        terminal: { id: "t1", spawnedAt: 1_000 },
      });
    }
  );

  it("needs the trash's deadline to call it a user close, and the incarnation to name it", () => {
    expect(attributeClose({ ...trashed, trashExpiresAt: undefined }, "kill", 20_000)).toEqual({
      closedBy: "kill",
      terminal: { id: "t1", spawnedAt: 1_000 },
    });
    expect(attributeClose({ ...trashed, spawnedAt: undefined }, "kill", 20_000)).toEqual({
      closedBy: "kill",
    });
    expect(attributeClose(null, "shutdown", 20_000)).toEqual({ closedBy: "shutdown" });
  });
});
