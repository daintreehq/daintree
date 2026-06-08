import { describe, it, expect } from "vitest";
import { buildConfirmMessage } from "../buildConfirmMessage";

describe("buildConfirmMessage", () => {
  describe("trash", () => {
    it("uses 'terminal' (singular) when count is 1", () => {
      expect(buildConfirmMessage("trash", 1, 0)).toBe("Trash 1 terminal?");
    });

    it("uses 'terminals' (plural) when count is 2", () => {
      expect(buildConfirmMessage("trash", 2, 0)).toBe("Trash 2 terminals?");
    });

    it("uses 'terminals' (plural) for larger counts", () => {
      expect(buildConfirmMessage("trash", 5, 0)).toBe("Trash 5 terminals?");
    });
  });

  describe("kill (sibling regression guard)", () => {
    it("uses 'terminal' (singular) when count is 1", () => {
      expect(buildConfirmMessage("kill", 1, 0)).toBe("Kill 1 terminal?");
    });

    it("uses 'terminals' (plural) when count is 3", () => {
      expect(buildConfirmMessage("kill", 3, 0)).toBe("Kill 3 terminals?");
    });
  });
});
