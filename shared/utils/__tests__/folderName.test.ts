import { afterEach, describe, it, expect } from "vitest";
import { folderNameLengthError, validateFolderName } from "../folderName.js";

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

describe("validateFolderName byte limits", () => {
  const cjk = (count: number) => "あ".repeat(count);
  const TOO_LONG = /^Folder name is too long.*255.*byte/i;

  // `vi.unstubAllGlobals` would also drop the globals the setup file stubbed.
  const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process")!;
  const setProcess = (value: unknown) =>
    Object.defineProperty(globalThis, "process", {
      value,
      configurable: true,
      writable: true,
    });

  afterEach(() => {
    Object.defineProperty(globalThis, "process", processDescriptor);
  });

  describe("on Linux", () => {
    it("rejects 100 CJK characters, 300 bytes", () => {
      expect(validateFolderName(cjk(100), { platform: "linux" })).toMatch(TOO_LONG);
    });

    it("accepts 85 CJK characters, exactly 255 bytes", () => {
      expect(validateFolderName(cjk(85), { platform: "linux" })).toBeNull();
    });

    it("rejects 86 CJK characters, 258 bytes", () => {
      expect(validateFolderName(cjk(86), { platform: "linux" })).toMatch(TOO_LONG);
    });

    it("rejects 255 bytes plus one", () => {
      expect(validateFolderName(`${cjk(85)}a`, { platform: "linux" })).toMatch(TOO_LONG);
    });

    it("counts astral characters as four bytes", () => {
      expect(validateFolderName("😀".repeat(63), { platform: "linux" })).toBeNull();
      expect(validateFolderName("😀".repeat(64), { platform: "linux" })).toMatch(TOO_LONG);
    });

    it("counts the trimmed name, not the padding around it", () => {
      expect(validateFolderName(`   ${cjk(85)}`, { platform: "linux" })).toBeNull();
    });

    it("keeps the plain message when the character count alone is over the limit", () => {
      expect(validateFolderName("a".repeat(256), { platform: "linux" })).toBe(
        "Folder name is too long"
      );
    });

    it("still accepts multibyte names within the limit", () => {
      expect(validateFolderName("日本語のプロジェクト", { platform: "linux" })).toBeNull();
      expect(validateFolderName("café", { platform: "linux" })).toBeNull();
    });
  });

  describe("on platforms that count characters", () => {
    it.each(["darwin", "win32"])("accepts 100 CJK characters on %s", (platform) => {
      expect(validateFolderName(cjk(100), { platform })).toBeNull();
    });

    it.each(["darwin", "win32"])("accepts 255 and rejects 256 UTF-16 units on %s", (platform) => {
      expect(validateFolderName("a".repeat(255), { platform })).toBeNull();
      expect(validateFolderName("a".repeat(256), { platform })).toBe("Folder name is too long");
    });

    it.each(["darwin", "win32"])("counts an astral character as two units on %s", (platform) => {
      expect(validateFolderName("😀".repeat(127), { platform })).toBeNull();
      expect(validateFolderName("😀".repeat(128), { platform })).toBe("Folder name is too long");
    });
  });

  describe("without an explicit platform", () => {
    it("follows this process's platform", () => {
      setProcess({ platform: "linux" });
      expect(validateFolderName(cjk(100))).toMatch(TOO_LONG);
      setProcess({ platform: "darwin" });
      expect(validateFolderName(cjk(100))).toBeNull();
    });

    it("lets an explicit platform win over this process's", () => {
      setProcess({ platform: "linux" });
      expect(validateFolderName(cjk(100), { platform: "darwin" })).toBeNull();
    });

    it("applies only the character limit to a platform it doesn't know", () => {
      expect(validateFolderName(cjk(100), { platform: "freebsd" })).toBeNull();
    });

    it("applies only the character limit when no platform is known", () => {
      setProcess(undefined);
      expect(validateFolderName(cjk(100))).toBeNull();
      expect(validateFolderName("a".repeat(256))).toBe("Folder name is too long");
    });
  });
});

describe("folderNameLengthError", () => {
  it("measures the name as written, without trimming", () => {
    expect(folderNameLengthError(` ${"a".repeat(255)}`, { platform: "darwin" })).toBe(
      "Folder name is too long"
    );
    expect(folderNameLengthError("あ".repeat(86), { platform: "linux" })).toMatch(/255 bytes max/);
    expect(folderNameLengthError("あ".repeat(85), { platform: "linux" })).toBeNull();
  });
});
