import { describe, it, expect } from "vitest";
import { buildConfirmLabels, buildConfirmMessage } from "../buildConfirmMessage";

describe("buildConfirmMessage", () => {
  describe("trash", () => {
    it("uses 'terminal' (singular) when count is 1", () => {
      expect(buildConfirmMessage("trash", 1, 0)).toBe("Trash 1 terminal?");
    });

    it("uses 'terminals' (plural) when count is 2", () => {
      expect(buildConfirmMessage("trash", 2, 0)).toBe("Trash 2 terminals?");
    });
  });

  describe("kill (sibling regression guard)", () => {
    it("uses 'terminals' (plural) when count is 3", () => {
      expect(buildConfirmMessage("kill", 3, 0)).toBe("Kill 3 terminals?");
    });
  });

  describe("buttons", () => {
    it("name what the confirm does to how many, verb first", () => {
      expect(buildConfirmLabels("restart", 1).confirm).toBe("Restart agent");
      expect(buildConfirmLabels("restart", 3).confirm).toBe("Restart agents");
      expect(buildConfirmLabels("reject", 5).confirm).toBe("Reject prompts");
    });

    it("name what the cancel calls off", () => {
      expect(buildConfirmLabels("kill", 2).cancel).toBe("Cancel kill");
      expect(buildConfirmLabels("reject", 5).cancel).toBe("Cancel rejection");
    });

    it("say which confirmation lapsed, starting a sentence", () => {
      expect(buildConfirmLabels("trash", 5).expired).toBe("Trash confirmation expired");
    });
  });
});
