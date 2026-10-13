import { describe, it, expect } from "vitest";
import { validateFolderName } from "../folderName.js";

describe("validateFolderName", () => {
  describe("accepts valid names", () => {
    it("plain name", () => {
      expect(validateFolderName("my-project")).toBeNull();
    });

    it("name with internal dot", () => {
      expect(validateFolderName("my.project")).toBeNull();
    });

    it("unicode name", () => {
      expect(validateFolderName("café")).toBeNull();
    });

    it("name at length boundary (255)", () => {
      expect(validateFolderName("a".repeat(255))).toBeNull();
    });

    it("hidden-style name with leading dot", () => {
      expect(validateFolderName(".github")).toBeNull();
    });
  });

  describe("rejects empty / blank / dot segments", () => {
    it("empty string", () => {
      expect(validateFolderName("")).toBe("Folder name is required");
    });

    it("whitespace only", () => {
      expect(validateFolderName("   ")).toBe("Folder name is required");
    });

    it("non-string input", () => {
      expect(validateFolderName(undefined as unknown as string)).toBe("Folder name is required");
    });

    it("single dot", () => {
      expect(validateFolderName(".")).toBe("Invalid folder name");
    });

    it("double dot", () => {
      expect(validateFolderName("..")).toBe("Invalid folder name");
    });
  });

  describe("rejects path separators", () => {
    it("forward slash", () => {
      expect(validateFolderName("foo/bar")).toBe("Folder name must not contain path separators");
    });

    it("backslash", () => {
      expect(validateFolderName("foo\\bar")).toBe("Folder name must not contain path separators");
    });
  });

  describe("rejects control characters", () => {
    it("null byte", () => {
      expect(validateFolderName("foo\x00bar")).toBe(
        "Folder name must not contain control characters"
      );
    });

    it("0x1F", () => {
      expect(validateFolderName("foo\x1Fbar")).toBe(
        "Folder name must not contain control characters"
      );
    });
  });

  describe("rejects Win32-illegal chars", () => {
    it.each(["<", ">", ":", '"', "|", "?", "*"])("rejects %s", (ch) => {
      expect(validateFolderName(`foo${ch}bar`)).toBe(
        'Folder name must not contain < > : " | ? or *'
      );
    });
  });

  describe("rejects trailing dot or space (Win32 silently strips)", () => {
    it("trailing dot", () => {
      expect(validateFolderName("foo.")).toBe("Folder name must not end with a space or period");
    });

    it("trailing space", () => {
      expect(validateFolderName("foo ")).toBe("Folder name must not end with a space or period");
    });
  });

  describe("rejects leading dash", () => {
    it("leading dash", () => {
      expect(validateFolderName("-flag")).toBe("Folder name must not start with '-'");
    });
  });

  describe("rejects Windows reserved device names", () => {
    it.each([
      "CON",
      "PRN",
      "AUX",
      "NUL",
      "COM0",
      "COM1",
      "COM9",
      "LPT0",
      "LPT1",
      "LPT9",
      "con",
      "Nul",
    ])("rejects bare %s", (name) => {
      expect(validateFolderName(name)).toMatch(/Windows-reserved/);
    });

    it.each(["CON.txt", "NUL.log", "COM1.anything", "lpt9.json"])(
      "rejects %s (extension still triggers)",
      (name) => {
        expect(validateFolderName(name)).toMatch(/Windows-reserved/);
      }
    );

    it("does not reject names that merely contain reserved substrings", () => {
      expect(validateFolderName("console")).toBeNull();
      expect(validateFolderName("auxiliary")).toBeNull();
      expect(validateFolderName("complete")).toBeNull();
    });
  });

  describe("rejects names that are too long", () => {
    it("256 chars", () => {
      expect(validateFolderName("a".repeat(256))).toBe("Folder name is too long");
    });
  });
});
